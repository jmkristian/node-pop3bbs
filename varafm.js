/** Utilities for exchanging data via VARA FM. */

const Bunyan = require('bunyan');
const EventEmitter = require('events');
const Net = require('net');
const Stream = require('stream');

const KByte = 1 << 10;
const optionSection = 'VARA FM';

const LogNothing = Bunyan.createLogger({
    name: 'stub',
    level: Bunyan.FATAL + 100,
});

function getLogger(options, that) {
    if (!(options && options.logger)) {
        return LogNothing;
    } else if (that) {
        return options.logger.child({'class': that.constructor.name});
    } else {
        return options.logger;
    }
}

function getDataSummary(data) {
    if (Buffer.isBuffer(data)) {
        if (data.length <= 32) {
            return data.toString('binary').replace(/\r/g, '\\r');
        } else {
            return data.toString('binary', 0, 32).replace(/\r/g, '\\r') + '...';
        }
    } else {
        var s = data + '';
        if (s.length <= 32) {
            return s.replace(/\r/g, '\\r');
        } else {
            return s.substring(0, 32).replace(/\r/g, '\\r') + '...';
        }
    }
}

/** Pipes data from a Readable stream to a fromVARA method. */
class VARAReceiver extends Stream.Writable {

    constructor(options, target) {
        super(); // The defaults are good.
        this.log = getLogger(options, this);
        this.target = target;
    }

    _write(chunk, encoding, callback) {
        try {
            if (!Buffer.isBuffer(chunk)) {
                throw `VARAReceiver._write chunk isn't a Buffer`;
            } else if (!this.target) {
                throw 'Lost received data ' + getDataSummary(chunk);
            } else {
                if (this.log.trace()) {
                    this.log.trace('VARA< %s', getDataSummary(chunk));
                }
                this.target.fromVARA(chunk);
            }
            callback(null);
        } catch(err) {
            this.log.error(err);
            callback(err);
        }
    }
}

/** Exchanges bytes between one local call sign and one remote call sign. */
class Connection extends Stream.Duplex {
    /* It's tempting to simply provide the dataSocket to the application,
       but this doesn't work. In particular, when the application calls
       connection.end(data), we must wait for VARA to report that it has
       transmitted all the data before closing the dataSocket.
       Also, the dataSocket doesn't always emit close when you expect.
    */

    constructor(options, dataSocket) {
        super({
            allowHalfOpen: true,
            emitClose: false, // emitClose: true doesn't always emit close.
            readableObjectMode: false,
            readableHighWaterMark: 4 * KByte,
            writableObjectMode: false,
            writableHighWaterMark: 4 * KByte,
        });
        this.log = getLogger(options, this);
        this.dataSocket = dataSocket;
        this.bufferLength = 0;
    }

    _write(data, encoding, callback) {
        if (this.iAmClosed) {
            callback();
        } else {
            this.log.debug('VARA data> %s', getDataSummary(data));
            this.bufferLength += data.length;
            this.dataSocket.write(data, encoding, callback);
        }
    }

    _read(size) {
        this.receiveBufferIsFull = false;
        // fromVARA calls this.push.
    }

    _final(callback) {
        this.log.debug('_final');
        callback();
    }

    _destroy(err, callback) {
        this.log.debug('_destroy');
        // The documentation seems to say this.destroy() should emit
        // 'end' and 'close', but I find that doesn't always happen.
        // This works reliably:
        if (!this.iAmClosed) {
            this.iAmClosed = true;
            this.emit('end');
            this.emit('close');
        }
        delete this.dataSocket;
        callback(err);
    }

    fromVARA(buffer) {
        this.log.debug('VARA data< ' + getDataSummary(buffer));
        if (!this.iAmClosed) {
            if (this.receiveBufferIsFull) {
                this.emit('error',
                          new Error('receive buffer overflow: '
                                    + getDataSummary(buffer)));
            } else {
                this.receiveBufferIsFull = !this.push(buffer);
            }
        }
    }

} // Connection

/** Similar to net.Server, but for VARA connections.
    Each 'connection' event provides a Duplex stream for exchanging data via
    one VARA connection. The remote call sign is connection.theirCall. To
    disconnect, call connection.end() or destroy(). The connection emits a
    'close' event when VARA is disconnected.
*/
class Server extends EventEmitter {

    constructor(options, onConnection) {
        super();
        this.options = options;
        this.myOptions = options && options[optionSection];
        this.log = getLogger(options, this);
        this.outputBuffer = [];
        if (onConnection) this.on('connection', onConnection);
        this.listen(options);
    }
    
    /** May be called repeatedly with different call signs. */
    listen(options, callback) {
        this.log.trace('listen(%o)', options);
        if (callback) {
            this.on('listening', callback);
        }
        if (this.myOptions) {
            this.myCall = this.myOptions.myCallSigns.join(' ');
        }
        if (this.myCall) {
            this.connectVARA();
        }
    }

    close(afterClose) {
        this.iAmClosed = true;
        this.socket.destroy();
        if (afterClose) afterClose();
    }

    toVARA(line, waitFor) {
        this.outputBuffer.push(line);
        this.outputBuffer.push(waitFor);
        if (this.waitingFor == null) {
            this.flushToVARA();
        }
    }

    flushToVARA() {
        if (this.outputBuffer.length) {
            var line = this.outputBuffer.shift();
            var waitFor = this.outputBuffer.shift();
            this.log.debug(`VARA> ${line}`);
            this.socket.write(line + '\r');
            this.waitingFor = waitFor;
        }
    }

    fromVARA(buffer) {
        if (this.inputBuffer == null) {
            this.inputBuffer = '';
        }
        this.inputBuffer += buffer.toString('utf-8');
        var CR;
        while (0 <= (CR = this.inputBuffer.indexOf('\r'))) {
            var line = this.inputBuffer.substring(0, CR);
            this.inputBuffer = this.inputBuffer.substring(CR + 1);
            this.log.debug(`VARA< ${line}`);
            var parts = line.split(/\s+/);
            var part0 = parts[0].toLowerCase();
            if (this.waitingFor != null && this.waitingFor.toLowerCase() == part0) {
                this.waitingFor = null;
                this.flushToVARA();
            }
            switch(part0) {
            case '':
                break;
            case 'pending':
                this.connectData();
                break;
            case 'connected':
                this.connectData(parts);
                break;
            case 'disconnected':
                this.disconnectData();
                break;
            case 'buffer':
                if ((this.connection.bufferLength = parseInt(parts[1])) <= 0
                    && this.endingData) {
                    this.dataSocket.end(); // which will emit a finish event
                    /* This isn't foolproof. If we send data simultaneous with
                       receiving 'BUFFER 0' from VARA, in which case we'd call
                       data.socket.end() prematurely and consequently VARA
                       would lose the data.
                    */
                }
                break;
            case 'missing':
                this.log.error(`VARA< ${line}`);
                this.close();
                break;
            case 'wrong':
                this.log.warn(`VARA< ${line}`);
                this.waitingFor = null;
                this.flushToVARA();
                break;
            default:
            }
        }
        this.log.trace('fromVARA returns');
    }

    connectVARA() {
        this.log.debug('connectVARA');
        if (this.socket) {
            this.socket.destroy();
        }
        this.socket = new Net.Socket();
        var that = this;
        this.socket.on('error', function(err) {
            if (err && `${err}`.includes('ECONNREFUSED')) {
                that.log.error('socket %s', err || '');
                that.close();
            } else {
                that.log.debug('socket error %s', err || '');
            }
        });
        // VARA closes the TNC connection at the end of each data connection.
        this.socket.on('close', function(info) {
            that.log.debug('socket close %s', info || '');
            if (!that.iAmClosed) {
                that.connectVARA();
            }
        });
        ['timeout', 'end', 'finish'].forEach(function(event) {
            that.socket.on(event, function(info) {
                that.log.debug('socket %s %s', event, info || '');
            });
        });
        this.socket.pipe(new VARAReceiver(this.options, this));
        this.socket.connect(this.myOptions);
        this.toVARA('VERSION', 'VERSION');
        this.toVARA(`MYCALL ${this.myCall}`, 'OK');
        // this.toVARA(`CHAT OFF`, 'OK');
        this.toVARA('LISTEN ON', 'OK');
    }

    connectData(parts) {
        if (!this.dataSocket) {
            this.dataSocket = new Net.Socket();
            this.dataReceiver = new VARAReceiver(this.options);
            this.dataSocket.pipe(this.dataReceiver);
            var that = this;
            ['error', 'timeout'].forEach(function(event) {
                that.dataSocket.on(event, function(info) {
                    if (that.connection) {
                        that.log.debug('dataSocket %s', event);
                        that.connection.emit(event, info);
                    } else {
                        that.log.warn('dataSocket %s %s', event, info);
                    }
                });
            });
            ['end', 'finish', 'close'].forEach(function(event) {
                that.dataSocket.on(event, function(err) {
                    if (err) that.log.warn('dataSocket finish %s', err);
                    else that.log.debug('dataSocket finish');
                    if (that.isConnected) {
                        that.toVARA('DISCONNECT');
                    }
                    that.disconnectData();
                });
            });
            this.dataSocket.connect({
                host: this.myOptions.host,
                port: this.myOptions.dataPort,
            });
            this.connection = new Connection(this.options, this.dataSocket);
            this.dataReceiver.target = this.connection;
            this.connection.on('finish', function(err) {
                if (err) that.log.warn('connection finish %s', err);
                else that.log.debug('connection finish');
                if (that.connection.bufferLength <= 0) {
                    that.dataSocket.end(); // which will emit a finish event
                } else {
                    /* If we end the dataSocket now, VARA will lose the data in
                       its buffer. So, wait until VARA reports that its buffer
                       is empty and then end the dataSocket.
                    */
                    that.endingData = true;
                }
            });
            ['end', 'close'].forEach(function(event) {
                that.connection.on(event, function(err) {
                    that.log.debug('connection %s %s', event, err || '');
                });
            });
        }
        if (parts) {
            this.connection.theirCall = parts[1];
            this.connection.myCall = parts[2];
            this.isConnected = true;
            this.emit('connection', this.connection);
        }
    }

    disconnectData() {
        this.isConnected = false;
        this.endingData = false;
        if (this.dataReceiver) {
            this.dataReceiver.target = null;
            delete this.dataReceiver;
        }
        if (this.connection) {
            try {
                this.connection.destroy();
            } catch(err) {
                this.log.error(err);
            }
            delete this.connection;
        }
        if (this.dataSocket) {
            try {
                this.dataSocket.end();
                this.dataSocket.destroy();
            } catch(err) {
                this.log.error(err);
            }
            delete this.dataSocket;
        }
    }

} // Server

exports.Server = Server;
exports.toDataSummary = getDataSummary;

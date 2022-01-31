/** Utilities for exchanging data with AGWPE. */

const Bunyan = require('bunyan');
const EventEmitter = require('events');
const Net = require('net');
const Stream = require('stream');

const HeaderLength = 36;
const NoPID = 0xF0;

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

function hexByte(from) {
    return ((from >> 4) & 0x0F).toString(16) + (from & 0x0F).toString(16)
}

function hexBuffer(buffer) {
    var hex = '';
    for (var f = 0; f < buffer.length; ++f) {
        if (hex) hex += ' ';
        hex += hexByte(buffer[f]);
    }
    return hex;
}

function getDataSummary(data) {
    if (data.length <= 32) {
        return data.toString('binary').replace(/\r/g, '\\r');
    } else {
        return data.toString('binary', 0, 32).replace(/\r/g, '\\r') + '...';
    }
}

function getFrameSummary(frame) {
    var summary = {};
    Object.assign(summary, frame);
    if (frame.data == null) {
        delete summary.data;
        delete summary.dataLen;
    } else if (frame.dataKind == 'S') {
        summary.data = frame.data.toString('binary');
        delete summary.dataLen;
    } else if (frame.data.length <= 32) {
        switch(frame.dataKind) {
        case 'g':
        case 'K':
        case 'R':
        case 'X':
        case 'Y':
        case 'y':
            summary.data = hexBuffer(frame.data);
            break;
        default:
            summary.data = getDataSummary(frame.data);
        }
        delete summary.dataLen;
    } else {
        summary.data = getDataSummary(frame.data);
        summary.dataLen = frame.data.length;
    }
    if (summary.user == 0) delete summary.user;
    if (summary.callTo == '') delete summary.callTo;
    if (summary.callFrom == '') delete summary.callFrom;
    return JSON.stringify(summary);
}

function mergeOptions(from) {
    var args = Array.from(arguments);
    var into = {};
    args.splice(0, 0, into);
    Object.assign.apply(Object, args);
    return into;
}

function getASCII(frame, offset) {
    var into = '';
    for (var i = offset; frame[i]; ++i) {
        into = into + String.fromCharCode(frame[i]);
    }
    return into;
}

function copyBuffer(from, start, end) {
    if (start == null) start = 0;
    if (end == null || end > from.length) end = from.length;
    var into = Buffer.alloc(end - start);
    from.copy(into, 0, start, end);
    return into;
}

/** Convert an object to a binary AGWPE frame. */
function toFrame(from, encoding) {
    var data = from.data;
    var dataLength = 0;
    if (data) {
        if ((typeof data) == 'string') {
            data = Buffer.from(data || '', encoding || 'utf-8');
        } else if (!Buffer.isBuffer(data)) {
            throw 'data is neither a string nor a buffer';
        }
        dataLength = data.length;
    }
    var frame = Buffer.alloc(HeaderLength + dataLength);
    frame.fill(0, 0, HeaderLength);
    frame[0] = from.port || 0;
    frame[4] = from.dataKind ? from.dataKind.charCodeAt(0) : 0;
    frame[6] = (from.PID != null) ? from.PID : NoPID;
    frame.write(from.callFrom || '', 8, 'ascii');
    frame.write(from.callTo || '', 18, 'ascii');
    frame.writeUInt32LE(dataLength, 28);
    if (dataLength) {
        data.copy(frame, HeaderLength);
    }
    frame.writeUInt32LE(from.user || 0, 32);
    return frame;
}

/** Convert a binary AGWPE frame header to an object. */
function fromHeader(buffer) {
    if (buffer.length < 36) {
        throw `buffer.length ${buffer.length} is shorter than a header`;
    }
    var into = {
        port: buffer[0],
        dataKind: buffer.toString('binary', 4, 5),
        PID: buffer[6],
        callFrom: getASCII(buffer, 8),
        callTo: getASCII(buffer, 18),
        user: buffer.readUInt32LE(32),
    };
    return into;
}

const EmptyBuffer = Buffer.alloc(0);

/** Transform binary AGWPE frames to objects. */
class TransformFromAGW extends Stream.Transform {

    constructor(options) {
        super({readableObjectMode: true});
        this.header = Buffer.alloc(HeaderLength);
        this.headerLength = 0;
        this.log = getLogger(options, this);
    }

    _transform(chunk, encoding, afterTransform) {
        if (encoding != 'buffer') {
            afterTransform(`TransformFromAGW._transform encoding ${encoding}`);
            return;
        }
        if (!Buffer.isBuffer(chunk)) {
            afterTransform(`TransformFromAGW._transform chunk isn't a Buffer`);
            return;
        }
        if (this.buffer) {
            // this.header is complete, but we need more data.
            var newBuffer = Buffer.alloc(this.buffer.length + chunk.length);
            this.buffer.copy(newBuffer, 0);
            chunk.copy(newBuffer, this.buffer.length);
            this.buffer = newBuffer;
        } else {
            // We need more header.
            var headerSlice = Math.min(HeaderLength - this.headerLength, chunk.length);
            if (headerSlice > 0) {
                chunk.copy(this.header, this.headerLength, 0, headerSlice);
                this.headerLength += headerSlice;
            }
            if (headerSlice < chunk.length) {
                this.buffer = copyBuffer(chunk, headerSlice);
            }
        }
        while(true) {
            if (this.headerLength < HeaderLength) {
                break; // Wait for more header.
            }
            var dataLength = this.header.readUInt32LE(28);
            var bufferLength = this.buffer ? this.buffer.length : 0;
            if (bufferLength < dataLength) {
                break; // Wait for more data.
            }
            // Produce a result:
            var result = fromHeader(this.header);
            result.data = (dataLength <= 0) ? EmptyBuffer
                : (dataLength == this.buffer.length)
                ? this.buffer
                : copyBuffer(this.buffer, 0, dataLength);
            // Shift the remaining data into this.header and this.buffer:
            this.headerLength = Math.min(HeaderLength, bufferLength - dataLength);
            if (this.headerLength > 0) {
                this.buffer.copy(this.header, 0, dataLength, dataLength + this.headerLength);
            }
            var newBufferLength = bufferLength - (dataLength + this.headerLength);
            this.buffer = (newBufferLength <= 0) ? null
                : copyBuffer(this.buffer, dataLength + this.headerLength);
            if (this.log.debug()) {
                this.log.debug('< %s', getFrameSummary(result));
            }
            this.push(result);
        }
        afterTransform();
    } // _transform
} // TransformFromAGW

/** Transform objects to binary AGWPE frames. */
class TransformToAGW extends Stream.Transform {

    constructor(options) {
        super({
            writableObjectMode: true,
            defaultEncoding: options && options.encoding,
        });
        this.log = getLogger(options, this);
    }

    _transform(chunk, encoding, afterTransform) {
        if ((typeof chunk) != 'object') {
            afterTransform(`TransformToAGW ${chunk}`);
        } else {
            var frame = toFrame(chunk, encoding);
            if (this.log.debug()) {
                this.log.debug('> %s', getFrameSummary(chunk));
            }
            afterTransform(null, frame);
        }
    }
} // TransformToAGW

/** Receives frames from a stream and passes them to a function.
    The function is injected by the object that wants the frames.
    Also re-emits some events that are emitted by the stream.
*/
class FrameRelay extends EventEmitter {

    constructor(fromAGW, options) {
        super();
        this.log = getLogger(options, this);
        var that = this;
        ['error', 'timeout', 'close'].forEach(function(event) {
            fromAGW.on(event, function(info) {
                that.emit(event, info);
            });
        });
        fromAGW.on('data', function(frame) {
            try {
                that.log.trace('relay %s frame', frame.dataKind);
                that.emitFrameFromAGW(frame);
            } catch(err) {
                that.log.error(err);
                that.emit('error', err);
            }
        });
    }
}

/** Creates a client object to handle each connection to an AGW port
    or a remote AX.25 station. Also, passes frames received via each
    connection to the client that handles that connection.
*/
class Router extends EventEmitter {

    constructor(toAGW, fromAGW, options, server) {
        super();
        this.toAGW = toAGW;
        this.fromAGW = fromAGW;
        this.options = options;
        this.server = server;
        this.log = getLogger(options, this);
        this.log.trace('new');
        this.clients = {};
        var that = this;
        ['error', 'timeout'].forEach(function(event) {
            fromAGW.on(event, function(info) {
                for (const c in that.clients) {
                    that.clients[c].emit(event, info);
                }
            });
        });
        var fromAGWClass = fromAGW.constructor.name;
        fromAGW.on('close', function onClose() {
            that.log.trace('closed %s', fromAGWClass);
            that.toAGW.destroy();
            for (const c in that.clients) {
                that.clients[c].destroy();
            }
            that.emit('close');
        });
        this.log.trace('set %s.emitFrameFromAGW', fromAGW.constructor.name);
        fromAGW.emitFrameFromAGW = function(frame) {
            var key = that.getKey(frame);
            var client = that.clients[key];
            if (!client) {
                client = that.newClient(frame);
                if (client) {
                    that.clients[key] = client;
                    client.on('end', function() {
                        that.log.trace('ended %s; delete client',
                                       client.constructor.name);
                        delete that.clients[key];
                    });
                }
            }
            try {
                that.log.trace('route %s frame to %s',
                               frame.dataKind, client && client.constructor.name);
                that.onFrameFromAGW(frame, client);
            } catch(err) {
                that.emit('error', err);
            }
        };
    }
} // Router

/** Manages objects that handle data to and from each AGW port. */
class PortRouter extends Router {

    constructor(toAGW, fromAGW, options, server) {
        super(toAGW, fromAGW, options, server);
        var that = this;
        fromAGW.on('error', function(err) {
            that.server.emit('error', err);
        });
    }

    getKey(frame) {
        return frame.port;
    }

    newClient(frame) {
        var throttle = new PortThrottle(this.toAGW, this.options, frame);
        var router = new ConnectionRouter(throttle, throttle, this.options, this.server);
        return throttle;
    }

    onFrameFromAGW(frame, client) {
        switch(frame.dataKind) {
        case 'G': // available ports
            var parts = frame.data.toString('ascii').split(';');
            var numberOfPorts = parseInt(parts[0], 10);
            this.server.setNumberOfPorts(numberOfPorts);
            for (var p = 0; p < numberOfPorts; ++p) {
                this.toAGW.write({dataKind: 'g', port: p});
            }
            break;
        case 'X': // registered myCall
            if (frame.data && frame.data.length > 0 && frame.data[0] == 1) {
                this.server.emit('listening', {port: frame.port, callTo: frame.callFrom});
            } else {
                this.server.emit('error', 'listen failed: ' + getFrameSummary(frame));
            }
            break;
        default:
            client.onFrameFromAGW(frame);
        }
    }
} // PortRouter

/** Manages objects that handle data to and from each remote station via AX.25. */
class ConnectionRouter extends Router {

    constructor(toAGW, fromAGW, options, server) {
        super(toAGW, fromAGW, options, server);
    }

    getKey(frame) {
        if (frame.dataKind == 'Y') {
            return `${frame.port} ${frame.callTo} ${frame.callFrom}`;
        } else {
            return `${frame.port} ${frame.callFrom} ${frame.callTo}`;
        }
    }

    newClient(frame) {
        if (frame.dataKind != 'C') { // connect
            return null;
        }
        var throttle = new ConnectionThrottle(this.toAGW, this.options, frame);
        var dataToFrames = new DataToFrames({
            port: frame.port,
            myCall: frame.callTo,
            theirCall: frame.callFrom,
            toAGW: throttle,
            frameLength: this.options.frameLength,
            logger: this.options.logger,
        });
        dataToFrames.pipe(throttle);
        var connection = new Connection(dataToFrames, this.options);
        var that = this;
        dataToFrames.on('end', function(info) {
            that.log.trace('ended %s; %s.end',
                           dataToFrames.constructor.name,
                           throttle.constructor.name);
            throttle.end();
        });
        throttle.on('end', function(info) {
            that.log.trace('ended %s; %s.emit close',
                           throttle.constructor.name,
                           connection.constructor.name);
            connection.emit('close', info);
        });
        this.log.trace('set %s.emitFrameFromAGW', throttle.constructor.name);
        throttle.emitFrameFromAGW = function onFrameFromAGW(frame) {
            connection.onFrameFromAGW(frame); 
        };
        this.server.emit('connection', connection);
        return throttle;
    }

    onFrameFromAGW(frame, client) {
        if (client) {
            client.onFrameFromAGW(frame);
            // Disconnect frames are handled by the client.
        }
    }
} // ConnectionRouter

const MaxFramesInFlight = 8;

/** Delay transmission of frames, to avoid overwhelming AGWPE.
    The frames aren't changed, merely delayed.
*/
class Throttle extends Stream.Transform {

    constructor(toAGW, options) {
        super({
            highWaterMark: 8,
            readableObjectMode: true,
            writableObjectMode: true,
        });
        this.toAGW = toAGW;
        this.log = getLogger(options, this);
        this.log.trace('new');
        this.inFlight = 0;
        this.maxInFlight = MaxFramesInFlight;
        var that = this;
        ['error', 'timeout', 'close'].forEach(function(event) {
            that.toAGW.on(event, function(info) {
                that.log.trace('%sed %s', event, that.toAGW.constructor.name);
                that.emit(event, info);
            });
        });
        this.pipe(this.toAGW);
    }

    updateFramesInFlight(frame) {
        this.inFlight = frame.data.readUInt32LE(0);
        this.log.trace('inFlight = %d', this.inFlight);
        this.pushBuffer();
    }

    pushBuffer() {
        if (!this.buffer) {
            if (!this.afterFlushed) {
                return;
            } else { // flushing is in progress
                var nextFrame = this.lastFrame
                    ? null // this.lastFrame has already been pushed.
                    : (this.createLastFrame && this.createLastFrame());
                if (nextFrame) {
                    // If you send a disconnect frame immediately,
                    // the previous data won't be transmitted.
                    // So wait until inFlight == 0 to send nextFrame.
                    this.log.trace('lastFrame = %j', nextFrame);
                    this.lastFrame = nextFrame;
                    this.buffer = {frame: nextFrame, afterPush: this.afterFlushed};
                    this.maxInFlight = 1;
                    this.afterFlushed = null;
                } else { // flushing is complete
                    this.afterFlushed();
                    this.afterFlushed = null;
                    return;
                }
            }
        }
        // There is a buffer. Can we push it?
        if (this.inFlight >= this.maxInFlight) {
            if (!this.polling) {
                this.log.trace('start polling');
                this.polling = setInterval(function(that) {
                    that.pushFrame(that.queryFramesInFlight());
                }, 2000, this);
            }
        } else {
            var nextBuffer = this.buffer;
            this.buffer = null;
            this.pushFrame(nextBuffer.frame, nextBuffer.afterPush);
            ++this.inFlight;
            if (this.inFlight < this.maxInFlight) {
                this.stopPolling();
            }
        }
    }

    pushFrame(frame, afterPush) {
        if (frame != null) {
            if (this.log.trace()) {
                this.log.trace(`pushFrame %s`, getFrameSummary(frame));
            }
            this.push(frame);
        }
        if (afterPush != null) {
            afterPush();
        }
    }

    stopPolling() {
        if (this.polling) {
            this.log.trace('stop polling');
            clearInterval(this.polling);
            this.polling = null;
        }
    }

    _transform(frame, encoding, afterTransform) {
        if (this.inFlight >= MaxFramesInFlight) {
            // Don't send it now.
            if (this.buffer) {
                var err = new Error('already have a buffer');
                this.log.error(err);
                this.emit('error', err);
                throw err;
            }
            this.buffer = {frame: frame, afterPush: afterTransform};
            if (this.log.trace()) {
                this.log.trace('postponed %s', getFrameSummary(frame));
            }
            this.pushBuffer();
        } else {
            this.pushFrame(frame, afterTransform);
            ++this.inFlight;
            if (this.inFlight < this.maxInFlight) {
                this.stopPolling();
                if (this.inFlight > 0 && (this.inFlight == this.maxInFlight / 2)) {
                    // Look ahead, to possibly avoid polling later:
                    this.pushFrame(this.queryFramesInFlight());
                }
            }
        }
    }

    _flush(afterFlushed) {
        this.log.trace('_flush');
        var that = this;
        this.afterFlushed = function destructor(err, data) {
            that.log.trace('afterFlushed');
            that.stopPolling();
            afterFlushed(err, data);
            that.unpipe(that.toAGW); // don't that.toAGW.end()
        }
        this.pushBuffer();
    }
} // Throttle

/* Limit the rate of frames to an AGW port. */
class PortThrottle extends Throttle {

    constructor(toAGW, options, frame) {
        super(toAGW, options);
        this.port = frame.port;
        // Each connection adds listeners to this.
        // The number of possible connections is very large, so:
        this.setMaxListeners(0); // unlimited
    }
    
    queryFramesInFlight() {
        return {
            dataKind: 'y',
            port: this.port,
        };
    }

    onFrameFromAGW(frame) {
        switch(frame.dataKind) {
        case 'g': // capabilities of this port
            break;
        case 'y': // frames waiting to be transmitted
            this.updateFramesInFlight(frame);
            break;
        default:
            this.emitFrameFromAGW(frame);
        }
    }
}

/* Limit the rate of frames to an AX.25 connection. */
class ConnectionThrottle extends Throttle {

    constructor(toAGW, options, frame) {
        super(toAGW, options);
        this.port = frame.port;
        this.myCall = frame.callTo;
        this.theirCall = frame.callFrom;
    }

    queryFramesInFlight(id) {
        return {
            dataKind: 'Y',
            port: this.port,
            callTo: this.theirCall,
            callFrom: this.myCall,
        };
    }
    
    onFrameFromAGW(frame) {
        switch(frame.dataKind) {
        case 'Y': // frames waiting to be transmitted
            this.updateFramesInFlight(frame);
            break;
        case 'd': // disconnected
            this.log.trace('received d frame');
            this.receivedDisconnect = true;
            this.emitFrameFromAGW(frame);
            break;
        default:
            this.emitFrameFromAGW(frame);
        }
    }

    createLastFrame() {
        return this.receivedDisconnect ? null : {
            dataKind: 'd', // disconnect
            port: this.port,
            callFrom: this.myCall,
            callTo: this.theirCall,
        };
    }
} // ConnectionThrottle

const MaxWriteDelay = 250; // msec

/** Transform a stream of data to a stream of AGW frames.
    To promote efficient transmission, data may be delayed for as long as
    MaxWriteDelay, while several chunks are combined into one AGW data frame,
    perhaps as long as options.frameLength.
*/
class DataToFrames extends Stream.Transform {

    constructor(options) {
        super({
            allowHalfOpen: false,
            emitClose: true,
            readableObjectMode: true,
            writableObjectMode: false,
            writableHighWaterMark: 1,
        });
        this.port = options.port;
        this.myCall = options.myCall;
        this.theirCall = options.theirCall;
        this.maxDataLength = options.frameLength || 256;
        this.log = getLogger(options, this);
        this.log.trace('new');
        this.bufferCount = 0;
        var toAGW = options.toAGW;
        var toAGWClass = toAGW.constructor.name;
        var that = this;
        ['error', 'timeout'].forEach(function(event) {
            toAGW.on(event, function(info) {
                if (info) {
                    that.log.trace('%sed %s; emit;%s %o',
                                   event, toAGWClass, event, info, );
                } else {
                    that.log.trace('%sed %s; emit %s',
                                   event, toAGWClass, event);
                }
                that.emit(event, info);
            });
        });
        toAGW.on('end', function(info) {
            if (!that.toAGWisClosed) {
                that.toAGWisClosed = true;
//                that.log.trace('ended %s; end', toAGWClass);
//                that.end();
            }
        });
        if (this.log.trace()) {
            ['finish', 'end'].forEach(function(event) {
                that.on('finish', function() {
                    that.log.trace('%sed', event);
                });
            });
        }
    }

    _transform(data, encoding, afterTransform) {
        try {
            if (!Buffer.isBuffer(data)) {
                throw new Error(`DataToFrames._transform ${typeof data}`);
            }
            if (this.log.trace()) {
                this.log.trace(`._transform %s`, getDataSummary(data))
            }
            if (this.bufferCount + data.length < this.maxDataLength) {
                if (this.buffer == null) {
                    this.buffer = Buffer.alloc(this.maxDataLength);
                    this.bufferCount = 0;
                }
                data.copy(this.buffer, this.bufferCount);
                this.bufferCount += data.length;
                afterTransform();
                // Start the timeout, if it's not already running:
                if (this.timeout == null) {
                    this.timeout = setTimeout(function(that) {
                        that.timeout = null;
                        that.pushBuffer();
                    }, MaxWriteDelay, this);
                }
            } else {
                // Push some data to AGW:
                /* Direwolf will split a frame into several AX.25 packets,
                   but it won't combine frames into one packet. So, it
                   pays to push part of data in one frame with this.buffer,
                   and push the remaining data in the next frame.
                */
                var dataNext = (this.buffer == null) ? 0 :
                    this.buffer.length - this.bufferCount;
                if (dataNext > 0) {
                    data.copy(this.buffer, this.bufferCount, 0, dataNext);
                    this.bufferCount += dataNext;
                }
                this.pushBuffer(); // stops the timeout
                for (; dataNext < data.length; dataNext += this.maxDataLength) {
                    var dataEnd = dataNext + this.maxDataLength;
                    if (dataEnd <= data.length) {
                        this.pushData(data.subarray(dataNext, dataEnd));
                    } else {
                        this.buffer = Buffer.alloc(this.maxDataLength);
                        this.bufferCount = data.length - dataNext;
                        data.copy(this.buffer, 0, dataNext);
                        // Restart the timeout:
                        this.timeout = setTimeout(function(that) {
                            that.timeout = null;
                            that.pushBuffer();
                        }, MaxWriteDelay, this);
                        break;
                    }
                }
                afterTransform();
            }
        } catch(err) {
            afterTransform(err);
        }
    }

    _flush(afterFlush) {
        this.log.trace(`_flush`);
        this.pushBuffer();
        afterFlush();
    }

    pushBuffer() {
        if (this.timeout != null) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
        if (this.bufferCount > 0) {
            var data = this.buffer.subarray(0, this.bufferCount);
            // The callback might ultimately call this._transform,
            // which might add more data into this.buffer or call
            // this.pushBuffer again. To prevent confusion:
            this.bufferCount = 0;
            this.buffer = null;
            if (!this.toAGWisClosed) {
                this.pushData(data);
            }
        }
    }

    pushData(data) {
        if (data.length > 0) {
            var frame = {
                dataKind: 'D',
                port: this.port,
                callFrom: this.myCall,
                callTo: this.theirCall,
                data: data,
            };
            this.push(frame);
        }
    }
} // DataToFrames

/** Exchanges bytes between one local call sign and one remote call sign. */
class Connection extends Stream.Duplex {

    constructor(toAGW, options) {
        super({
            allowHalfOpen: false,
            emitClose: true,
            readableObjectMode: false,
            writableObjectMode: false,
            writableHighWaterMark: 1,
        });
        this.toAGW = toAGW;
        this.port = toAGW.port;
        this.myCall = toAGW.myCall;
        this.theirCall = toAGW.theirCall;
        this.log = getLogger(options, this);
        this.log.trace('new');
        var that = this;
        var toAGWClass = toAGW.constructor.name;
        ['finish', 'end'].forEach(function(event) {
            toAGW.on(event, function() {
                that.toAGWisFinished = true;
                that.iAmClosed = true;
            });
            that.on(event, function() {
                if (!that.toAGWisFinished) {
                    that.log.trace('%sed; %s.end', event, toAGWClass);
                    that.toAGW.end();
                    // toAGW will transmit a 'disconnect' frame.
                }
            });
        });
        ['error', 'timeout'].forEach(function(event) {
            toAGW.on(event, function(info) {
                if (info) {
                    that.log.trace('%sed %s; emit %s %o',
                                   event, toAGWClass, event, info);
                } else {
                    that.log.trace('%sed %s; emit %s',
                                   event, toAGWClass, event);
                }
                that.emit(event, info);
            });
        });
    }

    onFrameFromAGW(frame) {
        this.log.trace('received %s frame', frame.dataKind);
        switch(frame.dataKind) {
        case 'D': // data
            if (!this.iAmClosed) {
                this.push(frame.data);
            }
            break;
        case 'd': // disconnect
            this.end();
            break;
        default:
        }
    }

    _read(size) {
        // onFrameFromAGW calls this.push.
    }

    _write(data, encoding, afterWrite) {
        this.toAGW.write(data, afterWrite);
    }
} // Connection

/** Similar to net.Server, but for AX.25 connections.
    Each 'connection' event provides a Duplex stream
    for exchanging data via one AX.25 connection.
*/
class Server extends EventEmitter {

    constructor(options, onConnect) {
        super();
        this.log = getLogger(options, this);
        this.numberOfPorts = null; // until notified otherwise
        this.fromAGW = new TransformFromAGW(options);
        this.toAGW = new TransformToAGW(options);
        var relay = new FrameRelay(this.fromAGW, options);
        var router = new PortRouter(this.toAGW, relay, options, this);
        if (onConnect) this.on('connection', onConnect);
        var that = this;
        var givenConnection = options && options.AGWPE && options.AGWPE.connection;
        var socket = givenConnection || new Net.Socket();
        ['error', 'timeout', 'close'].forEach(function(event) {
            socket.on(event, function(info) {
                that.log.trace('%s from socket; %s.emit %s',
                               event, that.fromAGW.constructor.name, event);
                that.fromAGW.emit(event, info);
            });
        });
        socket.pipe(this.fromAGW);
        this.toAGW.pipe(socket);
        if (!givenConnection) {
            socket.connect(options.AGWPE);
        }
        this.socket = socket;
        this.toAGW.write({dataKind: 'G'}); // Get information about all ports
    }
    
    /** May be called repeatedly with different call signs. */
    listen(options, callback) {
        // this.log.trace('listen(%o)', options);
        if (callback) {
            this.on('listening', callback);
        }
        var that = this;
        if (options.port == null) {
            if (this.numberOfPorts == null) {
                // Postpone this request until we know the numberOfPorts.
                if (!this.listenBuffer) {
                    this.listenBuffer = [];
                }
                this.listenBuffer.push(options);
            } else {
                for (var p = 0; p < this.numberOfPorts; ++p) {
                    this.listen(mergeOptions(options, {port: p}));
                }
            }
        } else if (Array.isArray(options.port)) {
            options.port.forEach(function(port) {
                that.listen(mergeOptions(options, {port: port}));
            });
        } else {
            this.toAGW.write({
                port: options.port,
                dataKind: 'X', // Register
                callFrom: options.callTo,
            });
        }
    }

    setNumberOfPorts(number) {
        this.numberOfPorts = number;
        if (this.listenBuffer) {
            var queue = this.listenBuffer;
            delete this.listenBuffer;
            var that = this;
            queue.forEach(function(options, port) {
                that.listen(mergeOptions(options, {port: port}));
            });
        }
    }

    close(afterClose) {
        this.socket.destroy();
        if (afterClose) afterClose();
    }
} // Server

exports.Reader = TransformFromAGW;
exports.Writer = TransformToAGW;
exports.Server = Server;

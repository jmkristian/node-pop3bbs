/** Send test data to clients.
    Send some data each time a line is received from a client.
    If the line starts with a number, send that many frames.
    If there's a second number, send that many bytes per frame.
    By default, send 1 frame of 1024 bytes.
*/

const Config = require('./config').readFile(process.argv[2] || 'config.ini');
const Readline = require('readline');
const Stream = require('stream');

const log = Config.logger;

/* The test data contains a line break every 32 bytes.
   The data aim to identify how they were passed to AGW.
   Each chunk starts with 'chunk XX' and contains the
   offsets of bytes in the chunk, as ASCII hex numbers.
   Each offset refers to its last character, except the
   offset at the end of a line refers to the line break.
*/
const Data256 = 
    '..............x0.............x1\r..............x2.............x3\r' +
    '..............x4.............x5\r..............x6.............x7\r' +
    '..............x8.............x9\r..............xa.............xb\r' +
    '..............xc.............xd\r..............xe.............xf\r';

function newTestData(size) {
    var data = Buffer.alloc(size);
    var next = 0;
    var x = 0;
    for (; x < (size >> 8); ++x) {
        data.write(Data256.replace(/x/g, (x & 0xF).toString(16)), next, 'ascii');
        data.write((x >> 4).toString(16), next, 'ascii');
        next += 256;
    }
    if (next < size) {
        data.write(Data256.slice(0, size - next)
                   .replace(/x/g, (x & 0xF).toString(16)),
                   next, 'ascii');
        data.write((x >> 4).toString(16), next, 'ascii');
    }
    return data;
}

class TestDataStream extends Stream.Readable {

    constructor(reps, size) {
        super({
            emitClose: false,
            objectMode: false,
            highWaterMark: size,
        });
        this.r = 1;
        this.reps = reps;
        this.size = size;
        log.info(`sending ${reps} * ${size}`);
    }

    _read(size) {
        try {
            if (this.r <= this.reps) {
                var data = newTestData(this.size);
                data.write(`chunk ${this.r}`, 0, 'ascii');
                log.info('push ' + data.slice(0, 16).toString('binary') + '...');
                this.push(data);
            }
        } catch(err) {
            this.push(`chunk ${this.r}: ${err}\r`);
        }
        this.r++;
    }
}

function serve(section, moduleName, flavor) {
    const options = Config[section];
    if (options) {
        const module = require(moduleName);
        const server = new module.Server(options, undefined, flavor);
        server.on('error', function(err) {log.warn(err, `${section} error`);});
        server.on('close', function(err) {log.info(`${section} closed`);});
        server.on('connection', function(connection) {
            log.info('%s connected from %s', section, connection.theirCall);
            connection.on('error', function(err) {log.warn(err, `${section}`);});
            connection.on('timeout', function(err) {log.warn(err, `${section}`);});
            connection.on('finish', function() {log.debug(`${section} finished`);});
            connection.on('end', function() {log.debug(`${section} ended`);});
            connection.on('close', function() {log.info(`${section} closed`);});
            var lines = Readline.createInterface({input: connection});
            lines.on('line', function(command) {
                try {
                    if (command.toLowerCase() == 'b') {
                        connection.end('Goodbye.\r');
                    } else {
                        var parts = command.split(/\s+/);
                        var reps = parts[0] ? parseInt(parts[0]) : 1;
                        var size = parts[1] ? parseInt(parts[1]) : 1024;
                        new TestDataStream(reps, size).pipe(connection);
                    }
                } catch(err) {
                    log.warn(err);
                    connection.end(`${line}: ${err}\r`);
                }
            });
        });
        server.listen({callTo: options.myCallSigns}, function(info) {
            log.info(`${section} listening %o`, info);
        });
    }
}

serve('AGWPE', './agwapi');
serve('VARA FM', './varaapi', 'FM');
serve('VARA HF', './varaapi', 'HF');

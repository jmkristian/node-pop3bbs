/** Send test data to AX.25 clients.
    Send some data each time a line is received from a client.
    If the line starts with a number, send that many frames.
    If there's a second number, send that many bytes per frame.
    By default, send 1 frame of 1024 bytes.
*/

const AGW = require('./agwapi');
const Config = require('./config').readFile('config.ini');
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
        data.write((x >> 8).toString(16), next, 'ascii');
        next += 256;
    }
    if (next < size) {
        data.write(Data256.slice(0, size - next)
                   .replace(/x/g, (x & 0xF).toString(16)),
                   next, 'ascii');
        data.write((x >> 8).toString(16), next, 'ascii');
    }
    return data;
}

class TestDataStream extends Stream.Readable {

    constructor(reps, size) {
        super({objectMode: true, emitClose: false});
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
                log.info('AX.25 push ' + data.slice(0, 16).toString('binary') + '...');
                this.push(data);
            }
        } catch(err) {
            this.push(`chunk ${this.r}: ${err}\r`);
        }
        this.r++;
    }
}

var server = new AGW.Server(Config);
server.on('error', function(err) {log.warn(err, `AGW error`);});
server.on('close', function(err) {log.info(`AGW closed`);});
server.on('connection', function(agw) {
    log.info('AX.25 connected from %s', agw.theirCall);
    agw.on('error', function(err) {log.warn(err, `AX.25`);});
    agw.on('finish', function() {log.debug(`AX.25 finished`);});
    agw.on('close', function() {log.info(`AX.25 closed`);});
    var lines = Readline.createInterface({input: agw});
    lines.on('line', function(command) {
        try {
            if (command == '') {
                agw.end('Goodbye.\r');
            } else {
                var parts = command.split(/\s+/);
                var reps = parts[0] ? parseInt(parts[0]) : 1;
                var size = parts[1] ? parseInt(parts[1]) : 1024;
                new TestDataStream(reps, size).pipe(agw);
            }
        } catch(err) {
            log.warn(err);
            agw.end(`${line}: ${err}\r`);
        }
    });
});
server.listen({callTo: 'W6JMK-1'}, function(info) {
    log.info('AGW listening %o', info);
});

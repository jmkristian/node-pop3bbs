/** Monitor AX.25 traffic. This works best with log.level=DEBUG in config.ini. */

const AGW = require('./agwpeapi');
const Config = require('./config').readFile(process.argv[2] || 'config.ini');
const Net = require('net');

const log = Config.logger;

try {
    var toAGW = new AGW.Writer({logger: log});
    var fromAGW = new AGW.Reader({logger: log});
    var socket = new Net.Socket();
    ['connect', 'close', 'end', 'error', 'lookup', 'ready', 'timeout']
        .forEach(function(event) {
            socket.on(event, function(info) {
                if (info === undefined) {
                    log.info(`socket %s`, event);
                } else {
                    log.info(`socket %s %o`, event, info);
                }
            });
            fromAGW.on(event, function(info) {
                if (info === undefined) {
                    log.info(`fromAGW %s`, event);
                } else {
                    log.info(`fromAGW %s %o`, event, info);
                }
            });
        });
    fromAGW.on('data', function(frame) {
        if (frame.dataKind == 'G') {
            var parts = frame.data.toString('ascii').split(';');
            var numberOfPorts = parseInt(parts[0], 10);
            for (var p = 0; p < numberOfPorts; ++p) {
                toAGW.write({dataKind: 'm', port: p}); // Monitor
                /*
                  toAGW.write({dataKind: 'M', port: 0, // Send an unproto packet
                  callFrom: Config.AGWPE.myCallSigns[0], callTo: 'ID',
                  data: 'CM87wj'});
                */
            }
        }
    });
    socket.connect(Config.AGWPE);
    socket.pipe(fromAGW);
    toAGW.pipe(socket);
    toAGW.write({dataKind: 'R'}); // Get version of the packet engine
    toAGW.write({dataKind: 'G'}); // Get information about all ports
} catch(err) {
    console.trace(err);
}

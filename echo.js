/** Echo AX.25 traffic. */

const AGW = require('./agwapi');
const Config = require('./config').readFile('config.ini');

var server = new AGW.Server(
    Config,
    function(c) {
        c.write('Hello.\r');
        c.on('data', function(chunk) {
            if (chunk.toString('ascii') == 'B\r') {
                c.end('Goodbye.\r');
            } else {
                c.write(chunk); // echo
            }
        });
        c.on('error', function(err) {
            throw err;
        });
        c.on('finish', function(err) {
            console.log(`finish`);
        });
        c.on('close', function(err) {
            console.log(`close`);
        });
    });
server.on('error', function(err) {
    throw err;
});
server.listen({callTo: 'W6JMK-1'}, function(info) {
    console.log('listening ' + JSON.stringify(info));
});

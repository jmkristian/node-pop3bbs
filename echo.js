/** Echo AX.25 traffic. */

const Config = require('./config').readFile(process.argv[2] || 'config.ini');

function serve(moduleName, flavor) {
    const module = require(moduleName);
    var server = new module.Server(
        Config,
        function(c) {
            c.write('Hello. Send "B" to disconnect.\r');
            c.on('data', function(chunk) {
                if (chunk.toString('ascii').toLowerCase() == 'b\r') {
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
        },
        flavor,
    );
    server.on('error', function(err) {
        console.log(moduleName + ' ' + flavor + ' error ' + (err || ''));
    });
}

if (Config.AGWPE) {
    serve('./agwapi');
}
if (Config['VARA FM']) {
    serve('./varaapi', 'FM');
}
if (Config['VARA HF']) {
    serve('./varaapi', 'HF');
}

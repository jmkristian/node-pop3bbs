/** Echo AX.25 traffic. */

const Config = require('./config').readFile(process.argv[2] || 'config.ini');
const AGWPE = require('./agwpeapi');
const VARA = require('./varaapi');

function serve(section, serverClass, flavor) {
    const options = Config[section];
    if (options) {
        const log = options.logger;
        const server = new serverClass(
            options,
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
                    console.log(`${section} ${flavor||''} error ${err}`);
                });
                c.on('finish', function(err) {
                    console.log(`${section} finish`);
                });
                c.on('close', function(err) {
                    console.log(`${section} close`);
                });
            },
            flavor
        );
        server.on('error', function(err) {
            console.log(section + ' ' + (flavor || '') + ' error ' + (err || ''));
        });
        server.listen({callTo: options.myCallSigns}, function(info) {
            log.info(`${section} listening %o`, info);
        });
   }
}

serve('AGWPE', AGWPE.Server);
serve('VARA FM', VARA.Server, 'FM');
serve('VARA HF', VARA.Server, 'HF');

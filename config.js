const Bunyan = require('bunyan');
const fs = require('fs');
const ini = require('ini');
const URL = require('url').URL;

const LogNothing = Bunyan.createLogger({
    name: 'BBS',
    level: Bunyan.FATAL + 100,
});

function groomTNC(config, section, defaultPort) {
    const options = config[section];
    if (options) {
        if (!options.logger) {
            if (config.log) {
                var newLog = Object.assign({}, config.log);
                newLog.name = section;
                options.logger = Bunyan.createLogger(newLog);
            } else {
                options.logger = LogNothing;
            }
        }
        options.port = parseInt(options.port || (defaultPort + ''));
        if (options.myCallSigns) {
            options.myCallSigns = options.myCallSigns.trim().split(/\s+/);
        } else {
            delete options.myCallSigns;
        }
    }
}

function groomVARA(config, section, defaultPort) {
    groomTNC(config, section, defaultPort);
    const options = config[section];
    if (options && options.dataPort) {
        options.dataPort = parseInt(`${options.dataPort}`);
    }
}

function groom(config) {
    if (!config.logger) {
        if (config.log) {
            if (!config.log.name) {
                config.log.name = 'BBS';
            }
            if (config.log.level) {
                config.log.level = Bunyan[config.log.level];
            }
            config.logger = Bunyan.createLogger(config.log);
        } else {
            config.logger = LogNothing;
        }
    }
    groomTNC(config, 'AGWPE', 8000);
    groomVARA(config, 'VARA HF', 8300);
    groomVARA(config, 'VARA FM', 8300);
    if (config.LDAP) {
        if (!config.LDAP.userIdAttribute) {
            config.LDAP.userIdAttribute = 'uid';
        }
        if (!config.LDAP.passwordAttribute) {
            config.LDAP.passwordAttribute = 'userPassword';
        }
        if (config.LDAP.URL) {
            config.LDAP.URL = config.LDAP.URL.split(/\s+/);
            var url = new URL(config.LDAP.URL[0]);
            if (!config.LDAP.host && url.hostname) {
                config.LDAP.host = url.hostname;
            }
            if (config.LDAP.port) {
                config.LDAP.port = parseInt(config.LDAP.port);
            } else if (url.port) {
                config.LDAP.port = ((typeof url.port) == 'string') ? parseInt(url.port) : url.port;
            } else if (url.protocol && url.protocol.toLowerCase() == 'ldaps') {
                config.LDAP.port = 636;
            } else {
                config.LDAP.port = 389;
            }
            if (!config.LDAP.bindDN && url.username != null) {
                config.LDAP.bindDN = url.username;
            }
            if (!config.LDAP.password && url.password != null) {
                config.LDAP.password = url.password;
            }
            if (!config.LDAP.baseDN && url.pathname && url.pathname.length > 1) {
                config.LDAP.baseDN = url.pathname.substring(1);
            } else {
                config.LDAP.baseDN = ''; // search from the root
            }
        } else {
            var url = 'ldap://';
            if (config.LDAP.host) {
                url += config.LDAP.host;
            }
            if (config.LDAP.port) {
                config.LDAP.port = parseInt(config.LDAP.port);
                url += `:${config.LDAP.port}`;
            }
            if (config.LDAP.baseDN) {
                url += `/${config.LDAP.baseDN}`;
            }
            config.LDAP.URL = url;
        }
    }
    if (config.POP) {
        config.POP.port = parseInt(config.POP.port || '110');
    }
    if (config.SMTP) {
        config.SMTP.port = parseInt(config.SMTP.port || '25');
    }
}

exports.readFile = function(fileName) {
    var config = ini.parse(fs.readFileSync(fileName, 'utf-8'));
    groom(config);
    return config;
}

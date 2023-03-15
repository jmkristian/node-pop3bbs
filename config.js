const fs = require('fs');
const ini = require('ini');
const URL = require('url').URL;

function groomTNC(config, defaultPort) {
    if (config) {
        config.port = parseInt(config.port || `${defaultPort}`);
        config.frameLength = parseInt(config.frameLength || '256');
        if (config.myCallSigns) {
            config.myCallSigns = config.myCallSigns.trim().split(/\s+/);
        }
    }
}

function groom(config) {
    groomTNC(config.AGWPE, 8000);
    groomTNC(config['VARA HF'], 8300);
    groomTNC(config['VARA FM'], 8300);
    if (config['VARA FM']) {
        config['VARA FM'].dataPort = parseInt(
            config['VARA FM'].dataPort || (config['VARA FM'].port + 1) + '');
    }
    if (config['VARA HF']) {
        config['VARA HF'].dataPort = parseInt(
            config['VARA HF'].dataPort || (config['VARA HF'].port + 1) + '');
    }
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
    if (config.log) {
        var Bunyan = require('bunyan');
        if (config.log.name == null) {
            config.log.name = ':';
        }
        if (config.log.level) {
            config.log.level = Bunyan[config.log.level];
        }
        config.logger = Bunyan.createLogger(config.log);
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

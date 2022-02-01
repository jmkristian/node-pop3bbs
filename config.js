const fs = require('fs');
const ini = require('ini');
const URL = require('url').URL;

function groom(config) {
    if (config.AGWPE) {
        config.AGWPE.port = parseInt(config.AGWPE.port || '8000');
        config.AGWPE.frameLength = parseInt(config.AGWPE.frameLength || '256');
        if (config.AGWPE.myCallSigns) {
            config.AGWPE.myCallSigns = config.AGWPE.myCallSigns.trim().split(/\s+/);
        }
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
            config.LDAP.port = parseInt(config.LDAP.port || '339');
            if (config.LDAP.host) {
                config.LDAP.URL = [`ldap://${config.LDAP.host}:${config.LDAP.port}`];
            }
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

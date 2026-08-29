const { CookieJar } = require('tough-cookie');

const jars = new Map();

function getJar(retailerId) {
  if (!jars.has(retailerId)) {
    jars.set(retailerId, new CookieJar());
  }
  return jars.get(retailerId);
}

function clearJar(retailerId) {
  jars.delete(retailerId);
}

module.exports = { getJar, clearJar };

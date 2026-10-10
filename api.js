'use strict';

module.exports = {
  async testConnection({ homey }) {
    return {
      sites: await homey.app.testConnection(),
    };
  },
};

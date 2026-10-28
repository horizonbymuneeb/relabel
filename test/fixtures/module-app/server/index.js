"use strict";

const { PulseStatusServer } = require("./pulse-status-server");

const server = new PulseStatusServer();
module.exports = { server };

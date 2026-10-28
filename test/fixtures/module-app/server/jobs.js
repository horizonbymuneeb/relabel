"use strict";

const { PulseStatusServer } = require("./pulse-status-server");

function describe() {
  return `jobs for ${PulseStatusServer.name}`;
}

module.exports = { describe };

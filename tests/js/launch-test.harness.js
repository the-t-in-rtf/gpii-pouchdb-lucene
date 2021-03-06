// A convenience script to start up a copy of the test harness for manual QA.
"use strict";
var fluid = require("infusion");
fluid.setLogging(true);

var gpii = fluid.registerNamespace("gpii");

require("./test-harness");

gpii.tests.pouch.lucene.harness({
    pouchPort:  "9999",
    lucenePort: "3599"
});


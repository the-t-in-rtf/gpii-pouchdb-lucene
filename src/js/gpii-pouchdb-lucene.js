// A wrapper to spin up an instance of couchdb-lucene for use in tests.  This is not intended for production use
// with CouchDB.
//
// The configuration options are:
//
// {
//   port:     "9999"                  // The port couchdb-lucene will run on
//   db: {
//     url:    "http://localhost:7986/" // The URL on which Pouch is running
//     nick:   "local",                // The "nickname" to use for the database when generating the configuration file.
// }
//
// NOTE:  This component cannot be used repeatedly in a `testCaseHolder` element without adding special steps to your
// test sequence.  Your first set of tests within a single `testCaseHolder` will generally succeed, but subsequent
// tests may:
//
// 1. Fail with messages about not being able to reach parts of a component that has already been destroyed.
// 2. Succeed, but generate messages about the port number already being in use.
// 3. Succeed, but only because they randomly managed to start up at the right time.
//
// To use multiple tests in a single `testCaseHolder`, your test sequences must:
//
// 1. Trigger an `onReadyForShutdown` event when you are finished with the rest of your sequence.
// 2. Listen for this component's `onShutdownComplete` event at the end of your test sequence.
//
// The end of your test sequence should look something like:
//
//    sequence: [
//        // Test something here
//        ...
//        // Tell pouchdb-lucene to shut down
//        {
//            func: "{gpii.pouch.lucene}.events.onReadyForShutdown.fire"
//        }
//        // Confirm that pouchdb-lucene is shut down
//        {
//            listener: "fluid.identity"
//            event:    "{gpii.pouch.lucene}.events.onShutdownComplete"
//        }
//    ]
//
// For more examples of using this component more than once in the same `testCaseHolder`, check out the tests in this
// package.
//
"use strict";
var fluid = fluid || require("infusion");
var gpii  = fluid.registerNamespace("gpii");

var AdmZip        = require("adm-zip");
var path          = require("path");
var os            = require("os");
var fs            = require("fs");
var child_process = require("child_process");

// There are some constants that we use in `npm` scripts as well as here, they are found in `package.json`.
var npmSettings = require("../../package.json");

// Configure our directory locations based on the module location and the OS temporary directory.
var basePath = fluid.module.resolvePath("%gpii-pouchdb-lucene/");
var zipPath  = path.resolve(basePath, npmSettings.config.zipPath);
var tmpDir   = os.tmpdir();

var fs = require("fs");

fluid.registerNamespace("gpii.pouch.lucene");
gpii.pouch.lucene.init = function (that){
    // Use our ID as a unique identifier so that we can avoid clobbering another instance.
    var outputDir = path.resolve(that.options.tmpDir, that.id);

    // Unpack the "dist" zip created when we were installed to create a new working directory.
    fluid.log("Creating working directory for this instance...");
    fluid.log("output dir = " + outputDir);

    if (!fs.existsSync(that.options.zipPath)) {
        fluid.fail("The specified couchdb-lucene zip file doesn't exist: '" + that.options.zipPath + "'...");
    }

    var distZip = new AdmZip(that.options.zipPath);
    distZip.extractAllTo(outputDir);

    that.workingDir = path.resolve(outputDir, "couchdb-lucene-" + npmSettings.config.version);
    var confFile   = path.resolve(that.workingDir, "conf", "couchdb-lucene.ini");

    fluid.log("Generating configuration file...");
    var iniContent = gpii.pouch.lucene.generateIniContent(that);
    fs.writeFileSync(confFile, iniContent);

    // Start the service using either the batch file on windows, or the shell script on anything else.
    fluid.log("Starting couchdb-lucene...");

    var isWindows = os.platform().indexOf("win") === 0;
    var script = isWindows ? "": "sh " + path.resolve(that.workingDir, "bin", isWindows ? "run.bat" : "run");

    // The unix script is not always executable when it's unpacked.
    that.process = child_process.exec(script, { cwd: that.workingDir}, that.respondToProcessTermination);

    // We have to do this with an interval because all other methods have failed us horribly.  Somehow an initial
    // check is too early, and a check after our process has been created is too late.  We are left with polling...
    that.interval = setInterval(that.checkForStartupMessage, that.options.pollInterval);
};

// Report any errors if the process ends abnormally.  We do not care about "normal" process kills, only abnormal exits.
//
// Thus we look only for output to stderr.
gpii.pouch.lucene.respondToProcessTermination = function (that, stderr) {
    if (stderr) {
        // This is not a fail because we want the rest of the shutdown and cleanup to complete
        fluid.log("The Lucene process stopped with an error:\n", stderr.toString());
    }

    that.events.onShutdownComplete.fire();
};

// Ensure that the service is stopped on component destruction
gpii.pouch.lucene.stopProcess = function (that) {
    if (that.process) {
        that.process.kill();
    }
};

// Periodically examine the contents of `that.workingDir` + `logs/couchdb-lucene.log`.
//
// We are looking for the text "Accepting connections", if we find it we fire an `onStarted` event.
//
// We have to do it this way because:
//
// 1. binding a listener to the stdout stream for the process won't work if the message we are looking for has already been sent.
// 2. monitoring the log directory or file seems to miss the startup on later passes.
//
gpii.pouch.lucene.checkForStartupMessage = function (that) {
    var filePath = path.resolve(that.workingDir, "logs/couchdb-lucene.log");
    if (fs.existsSync(filePath)) {
        var stringContent = fs.readFileSync(filePath, {encoding: "utf8"});
        if (stringContent.indexOf("Accepting connections") !== -1) {
            clearInterval(that.interval);

            // pouchdb-lucene is actually ready a few milliseconds after the log message we look for.
            setTimeout(function(){ that.events.onStarted.fire(that); }, that.options.startupDelay);
        }
    }
};

gpii.pouch.lucene.generateIniContent = function(that) {
    var output = "";
    fluid.each(that.options.iniSettings, function(settings, section){
        output += "\n[" + section + "]\n";

        fluid.each(settings, function (value, key){
            output += key + "=" + value + "\n";
        });
    });

    return output;
};

fluid.defaults("gpii.pouch.lucene", {
    gradeNames:     ["fluid.component"],
    port:           9999,
    pollInterval:   250,
    startupDelay:   250, // How long to wait before reporting that couchdb-lucene is ready.
    dbUrl:          "http://localhost:5986/ul",
    // The settings we will write to couchdb-lucene's configuration file.  Each top level key will become a section
    // entry, as in [lucene].  Each sub key-value pair will become an entry, as in dir=indexes
    iniSettings: {
        lucene: {
            dir:                  "indexes",
            host:                 "localhost",
            port:                 "{that}.options.port",
            limit:                25,
            allowLeadingWildcard: false
        },
        local: {
            url:  "{that}.options.dbUrl"
        }
    },
    // The location of our distribution zip and working directory.  You should not need to change these.
    zipPath:     zipPath,
    tmpDir:      tmpDir,
    members: {
        isStarted: false,
        process:   false
    },
    events: {
        onStarted:          null,
        onReadyForShutdown: null,
        onShutdownComplete: null
    },
    listeners: {
        "onCreate.init": {
            funcName: "gpii.pouch.lucene.init",
            args:     ["{that}"]
        },
        "onReadyForShutdown.stopProcess": {
            funcName: "gpii.pouch.lucene.stopProcess",
            args:     ["{that}"]
        },
        "onStarted.log": {
            funcName: "fluid.log",
            args:     ["pouchdb-lucene started successfully..."]
        },
        "onReadyForShutdown.log": {
            funcName: "fluid.log",
            args:     ["pouchdb-lucene ready for shutdown..."]
        },
        "onShutdownComplete.log": {
            funcName: "fluid.log",
            args:     ["pouchdb-lucene shutdown complete..."]
        }
    },
    invokers: {
        checkForStartupMessage: {
            funcName: "gpii.pouch.lucene.checkForStartupMessage",
            args:     ["{that}", "{arguments}.1"] // the callback is passed: event, filename
        },
        respondToProcessTermination: {
            funcName: "gpii.pouch.lucene.respondToProcessTermination",
            args:     ["{that}", "{arguments}.2"] // the process callback is passed: error, stdout, stderr
        }
    }
});
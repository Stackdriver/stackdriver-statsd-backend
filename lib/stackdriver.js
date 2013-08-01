/*jshint node:true, laxcomma:true */

/*
 * Flush stats to Stackdriver (http://www.stackdriver.com/).
 *
 * To enable this backend, include 'stackdriver' in the backends
 * configuration array:
 *
 *   backends: ['stackdriver']
 *
 * This backend supports the following config options:
 *
 *	apiKey: Your Stackdriver API key, generated in your account settings
 *  source: The instance ID of the AWS machine that the values should be associated with (optional)
 *  debug: Print extra logging if this is set to true (optional)
 *   
 * This backend has been adapted using the backends provided with the
 * main statsd distribution for guidance. (https://github.com/etsy/statsd) 
 */

var util = require('util');
var https = require('https');

// statsd internal metrics start with statsd., making a regex so we can strip
// them out
var internalMetricsPrefix = /^statsd\./;

/*
 * Create the Stackdriver backend object, initialized from inside statsd.
 * 
 * Sets up the flush and status handlers, reads the configuration, arranges
 * various local state.
 */
function StackdriverBackend(startupTime, config, emitter) {
	var self = this;
	this.apiKey = config.stackdriver.apiKey;
	this.source = config.stackdriver.source;
	this.debug = config.stackdriver.debug;
	this.stackdriverHost = 'custom-gateway.stackdriver.com';
	this.stackdriverPath = '/v1/custom';
	this.userAgent = 'stackdriver-statsd-backend/0.0.1';

	this.lastFlush = startupTime;
	this.lastException = startupTime;
	this.config = config.console || {};

	if (!this.apiKey) {
		util.error("ERROR: no api key set, all flush operations will no-op!");
	}

	if (this.debug) {
		util.log('Stackdriver backend is running in debug mode, extra logging will occur');
	}
	if (this.source) {
		util.log('Source param set to ' + source	+ ', all points sent to Stackdriver will be associated with that instance');
	}

	// attach
	emitter.on('flush', function(timestamp, metrics) {
		self.flush(timestamp, metrics);
	});
	emitter.on('status', function(callback) {
		self.status(callback);
	});
}

/*
 * Add a data point into the gateway message, decorating it with an instance ID
 * if the source is set in the config
 */
StackdriverBackend.prototype.add_point_to_message = function(stackdriverMessage, point) {
	// decorate with instance ID if source was set
	if (this.source) {
		point.instanceId = this.source;
	}
	// add the point to the message object
	stackdriverMessage.data.push(point);
}

/*
 * HTTPS post the message with the data to the Stackdriver gateway
 */
StackdriverBackend.prototype.post_message_to_gateway = function(stackdriverMessage) {
	// setup the HTTPS request
	var request_options = {
		host : this.stackdriverHost,
		port : 443,
		path : this.stackdriverPath,
		method : 'POST',
		headers : {
			"Content-Length" : stackdriverMessage.length,
			"Content-Type" : "application/json; charset=utf-8",
			"User-Agent" : this.userAgent,
			"x-stackdriver-apikey" : this.apiKey
		}
	};

	// TODO: post message to HTTP, echoing here for testing now
	if (this.debug) {
		util.log("Message contents to be posted:");
		util.log(JSON.stringify(stackdriverMessage));
	}
};

/*
 * Root handler for flushing data from statsd to Stackdriver.
 * 
 * Makes a message out of the various data points and calls the post method.
 */
StackdriverBackend.prototype.flush = function(timestamp, metrics) {

	if (!this.apiKey) {
		console.log("ERROR Stackdriver API key not set, returning prematurely");
		return;
	}

	util.log('Flushing stats at' + new Date(timestamp * 1000).toString());

	var stackdriverMessage = {
		proto_version : 1,
		timestamp : timestamp,
		data : []
	};

	// add any counters to the message
	for (counter_key in metrics.counters) {
		if (counter_key.match(internalMetricsPrefix) != null) {
			if (this.debug) {
				util.log("Skipping internal metric " + counter_key);
			}
			continue;
		} else {
			if (this.debug) {
				util.log("Found counter " + counter_key);
			}
			this.add_point_to_message(stackdriverMessage, {
				name : counter_key + ".count",
				value : metrics.counters[counter_key]
			});
		}
	}

	// add counter rates to the message
	for (counter_key in metrics.counter_rates) {
		if (counter_key.match(internalMetricsPrefix) != null) {
			if (this.debug) {
				util.log("Skipping internal metric " + counter_key);
			}
			continue;
		} else {
			if (this.debug) {
				util.log("Found counter rate" + counter_key);
			}
			this.add_point_to_message(stackdriverMessage, {
				name : counter_key + ".rate",
				value : metrics.counter_rates[counter_key]
			});
		}
	}

	// add gauge values to the message
	for (gauge_key in metrics.gauges) {
		if (gauge_key.match(internalMetricsPrefix) != null) {
			if (this.debug) {
				util.log("Skipping internal metric " + gauge_key);
			}
			continue;
		} else {
			if (this.debug) {
				util.log("Found gauge " + gauge_key);
			}
			this.add_point_to_message(stackdriverMessage, {
				name : gauge_key + ".value",
				value : metrics.gauges[gauge_key]
			});
		}
	}

	// add timer values to the message
	for (timer_key in metrics.timer_data) {
		if (timer_key.match(internalMetricsPrefix) != null) {
			if (this.debug) {
				util.log("Skipping internal metric " + timer_key);
			}
			continue;
		} else {
			if (this.debug) {
				util.log("Found timer " + timer_key);
			}

			// make points based on the different timer values, with appropriate
			// suffixing
			this.add_point_to_message(stackdriverMessage, {
				name : timer_key + ".count",
				value : metrics.timer_data[timer_key]["count"]
			});
			this.add_point_to_message(stackdriverMessage, {
				name : timer_key + ".rate",
				value : metrics.timer_data[timer_key]["count_ps"]
			});
			this.add_point_to_message(stackdriverMessage, {
				name : timer_key + ".max",
				value : metrics.timer_data[timer_key]["upper"]
			});
			this.add_point_to_message(stackdriverMessage, {
				name : timer_key + ".min",
				value : metrics.timer_data[timer_key]["lower"]
			});
			this.add_point_to_message(stackdriverMessage, {
				name : timer_key + ".sum",
				value : metrics.timer_data[timer_key]["sum"]
			});
			this.add_point_to_message(stackdriverMessage, {
				name : timer_key + ".avg",
				value : metrics.timer_data[timer_key]["mean"]
			});
		}
	}

	// send the message to the Stackdriver gateway
	if (stackdriverMessage.data.length > 0) {
		util.log(stackdriverMessage.data.length
				+ " metrics found, posting to Stackdriver");
		this.post_message_to_gateway(stackdriverMessage);
	} else {
		if (this.debug) {
			util.log("No points to send");
		}
	}

	// update the last flushed time
	this.lastFlush = Math.round(new Date().getTime() / 1000);
};

/*
 * Root handler for this backend to report its status back to statsd
 */
StackdriverBackend.prototype.status = function(write) {
	[ 'lastFlush', 'lastException' ].forEach(function(key) {
		write(null, 'stackdriver', key, this[key]);
	}, this);
};

/*
 * Initialize the output writer, set up the object which will register its
 * handlers
 */
exports.init = function(startupTime, config, events) {
	var instance = new StackdriverBackend(startupTime, config, events);
	return true;
};

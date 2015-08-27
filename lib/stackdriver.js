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
	this.sourceFromPrefix = ('sourceFromPrefix' in config.stackdriver) ? config.stackdriver.sourceFromPrefix : false;
	this.sourcePrefixSeparator = ('sourcePrefixSeparator' in config.stackdriver) ? config.stackdriver.sourcePrefixSeparator : "--";
	this.debug = config.stackdriver.debug;

	// Let users filter out stats they won't use
	this.sendCounters = ('sendCounters' in config.stackdriver) ? config.stackdriver.sendCounters : true;
	this.sendCounterRates = ('sendCounterRates' in config.stackdriver) ? config.stackdriver.sendCounterRates : true;
	this.sendGauges = ('sendGauges' in config.stackdriver) ? config.stackdriver.sendGauges : true;
	this.sendTimerCounters = ('sendTimerCounters' in config.stackdriver) ? config.stackdriver.sendTimerCounters : true;
	this.sendTimerRates = ('sendTimerRates' in config.stackdriver) ? config.stackdriver.sendTimerRates : true;
	this.sendTimerMins = ('sendTimerMins' in config.stackdriver) ? config.stackdriver.sendTimerMins : true;
	this.sendTimerMaxes = ('sendTimerMaxes' in config.stackdriver) ? config.stackdriver.sendTimerMaxes : true;
	this.sendTimerSums = ('sendTimerSums' in config.stackdriver) ? config.stackdriver.sendTimerSums : true;
	this.sendTimerAvgs = ('sendTimerAvgs' in config.stackdriver) ? config.stackdriver.sendTimerAvgs : true;
	
	// Timer percentiles are set to false by default since we didn't have those in earlier revs
	this.sendTimerPercentiles = ('sendTimerPercentiles' in config.stackdriver) ? config.stackdriver.sendTimerPercentiles : false;
	
	// statsd defaults to continue sending zero values for count/rate variables
	// This can be set to off to "age out" metrics that are no longer sent to statsd
	this.sendZeroTimersAndRates = ('sendZeroTimersAndRates' in config.stackdriver) ? config.stackdriver.sendZeroTimersAndRates : true;

	// Use the default 90th percentile as supplied in statsd if none are configured
	this.percentileValues = ('percentThreshold' in config) ? config.percentThreshold : ['90'];
	
	if (this.debug) {
		util.log('Stackdriver Backend set to report timer percentiles ' + this.percentileValues);
	}
	
	this.sendSets = ('sendSets' in config.stackdriver) ? config.stackdriver.sendSets : true;

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

	if (this.sourceFromPrefix) {
		util.log('Source will be inferred from each metric prefix, separated by "' + this.sourcePrefixSeparator + '", all points sent to Stackdriver for that metric will be associated with that instance');
	} else if (this.source) {
		var sys = require('sys');
	 	var exec = require('child_process').exec;

	 	if (this.source == 'detect-aws') {
	 		// Amazon EC2 instance - connect to local metadata service to grab instance ID
		 	var child = exec('wget -q -O - http://169.254.169.254/latest/meta-data/instance-id', function(error, stdout, stdin) {
		 		self.source = stdout;
		 		util.log('Auto-detected aws instance id as ' + self.source);
		  	});
	 	} else if (this.source == 'detect-gce') {
	 		// Google Compute Engine instance - connect to local metadata service to grab instance ID
	 		var child = exec('wget -q -O - http://metadata/computeMetadata/v1/instance/id --header "X-Google-Metadata-Request: true"', function(error, stdout, stdin) {
		 		self.source = stdout;
		 		util.log('Auto-detected gce instance id as ' + self.source);
		  	});	
	 	}

		util.log('Source param set to ' + this.source + ', all points sent to Stackdriver will be associated with that instance');
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
	// decorate with instance ID if source or sourceFromPrefix was set
	if (this.sourceFromPrefix) {
		var sep = point.name.indexOf(this.sourcePrefixSeparator);
		if (sep <= 0) {
			if (this.debug) {
				util.log('No prefix separator ("' + this.sourcePrefixSeparator + '") found in metric name, ' + point.name + ' will be sent as a regular custom metric not attached to an instance');
				// note that we'll still send the point, just without an instance property
			}
		} else {
			point.instance = point.name.substring(0, sep);
			point.name = point.name.substring(sep + this.sourcePrefixSeparator.length);
			if (this.debug) {
				util.log('Prefix separator ("' + this.sourcePrefixSeparator + '") found in metric name, ' + point.name + ' will be used as the metric name, and attached to instance id ' + point.instance);
			}
		}
	} else if (this.source) {
		point.instance = this.source;
	}
	// add the point to the message object
	stackdriverMessage.data.push(point);
}

/*
 * HTTPS post the message with the data to the Stackdriver gateway
 */
StackdriverBackend.prototype.post_message_to_gateway = function(stackdriverMessage) {
	// double check this here
	if (!this.apiKey) {
		util.error("No API key set, Stackdriver API key must be set before posting data");
		return;
	}
	
	if (!stackdriverMessage) {
		util.error("No message to send.  Need a Stackdriver Custom Metrics JSON message");
		return;
	}
	
	messageString = JSON.stringify(stackdriverMessage)
	
	// setup the HTTPS request
	var options = {
		host : this.stackdriverHost,
		path : this.stackdriverPath,
		method : 'POST',
		headers : {
			"Content-Length" : messageString.length,
			"Content-Type" : "application/json; charset=utf-8",
			"x-stackdriver-apikey" : this.apiKey,
			"User-Agent": "stackdriver-statsd-backend-0.1.2"
		}
	};
	
	util.log(JSON.stringify(options));

	if (this.debug) {
		util.log("Message contents to be posted:");
		util.log(messageString);
	}

	// perform the HTTPS request
	var req = https.request(options, function(res) {
		if (this.debug) {
			util.log("statusCode: ", res.statusCode);
			util.log("headers: ", res.headers);
		}
		
		// 4xx and 5xx errors
		if (Math.floor(res.statusCode / 100) == 4 || Math.floor(res.statusCode / 100) == 5){
			util.error(res.statusCode + " error sending to Stackdriver");
		}
		
		res.on('data', function(chunk) {
			util.log("STACKDRIVER GATEWAY RESPONSE: " + chunk);
		});
	});
	req.write(messageString);
	req.end();

	req.on('error', function(e) {
		util.error(e);
	});
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
		timestamp : timestamp,
		proto_version : 1,
		data : []
	};

	// add any counters to the message
	if (this.sendCounters) {
		for (counter_key in metrics.counters) {
			if (counter_key.match(internalMetricsPrefix) != null) {
				if (this.debug) {
					util.log("Skipping internal metric " + counter_key);
				}
				continue;
			} else {
				if (metrics.counters[counter_key] == 0 && !this.sendZeroTimersAndRates) {
				  if (this.debug) {
				    util.log("Skipping zero value counter " + counter_key)
				  }
				  continue
				} else if (this.debug) {
          util.log("Found counter " + counter_key);
        }

				this.add_point_to_message(stackdriverMessage, {
					name : counter_key + ".count",
					value : metrics.counters[counter_key],
					collected_at: timestamp
				});
			}
		}
	}

	// add counter rates to the message
	if (this.sendCounterRates) {
		for (counter_key in metrics.counter_rates) {
			if (counter_key.match(internalMetricsPrefix) != null) {
				if (this.debug) {
					util.log("Skipping internal metric " + counter_key);
				}
				continue;
			} else {
			  if (metrics.counter_rates[counter_key] == 0 && !this.sendZeroTimersAndRates) {
          if (this.debug) {
            util.log("Skipping zero value counter rate " + counter_key)
          }
          continue
        } else if (this.debug) {
					util.log("Found counter rate " + counter_key);
				}
				this.add_point_to_message(stackdriverMessage, {
					name : counter_key + ".rate",
					value : metrics.counter_rates[counter_key],
					collected_at: timestamp
				});
			}
		}
	}

	// add gauge values to the message
	if (this.sendGauges) {
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
					value : metrics.gauges[gauge_key],
					collected_at: timestamp
				});
			}
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
			if (this.sendTimerCounters) {
			  if (metrics.timer_data[timer_key]["count"] == 0 && !this.sendZeroTimersAndRates) {
          if (this.debug) {
            util.log("Skipping zero value timer count " + timer_key)
          }
        } else {
  				this.add_point_to_message(stackdriverMessage, {
  					name : timer_key + ".count",
  					value : metrics.timer_data[timer_key]["count"],
  					collected_at: timestamp
  				});
        }
			}
			if (this.sendTimerRates) {
			  if (metrics.timer_data[timer_key]["count_ps"] == 0 && !this.sendZeroTimersAndRates) {
          if (this.debug) {
            util.log("Skipping zero value timer rate " + timer_key)
          }
        } else {
  				this.add_point_to_message(stackdriverMessage, {
  					name : timer_key + ".rate",
  					value : metrics.timer_data[timer_key]["count_ps"],
  					collected_at: timestamp
  				});
        }
			}
			if (this.sendTimerMaxes && typeof(metrics.timer_data[timer_key]["upper"]) != "undefined") {
				this.add_point_to_message(stackdriverMessage, {
					name : timer_key + ".min",
					value : metrics.timer_data[timer_key]["lower"],
					collected_at: timestamp
				});
			}
			if (this.sendTimerMins && typeof(metrics.timer_data[timer_key]["lower"]) != "undefined") {
				this.add_point_to_message(stackdriverMessage, {
					name : timer_key + ".max",
					value : metrics.timer_data[timer_key]["upper"],
					collected_at: timestamp
				});
			}
			if (this.sendTimerSums && typeof(metrics.timer_data[timer_key]["sum"]) != "undefined") {
				this.add_point_to_message(stackdriverMessage, {
					name : timer_key + ".sum",
					value : metrics.timer_data[timer_key]["sum"],
					collected_at: timestamp
				});
			}
			if (this.sendTimerAvgs && typeof(metrics.timer_data[timer_key]["mean"]) != "undefined") {
				this.add_point_to_message(stackdriverMessage, {
					name : timer_key + ".avg",
					value : metrics.timer_data[timer_key]["mean"],
					collected_at: timestamp
				});
			}
			if (this.sendTimerPercentiles) {
				// send a point for each configured percentile, defaults to just 90th per statsd default
				for (var i=0; i < this.percentileValues.length; i++) {
				  var normalizedPercentile = this.percentileValues[i].toString().replace(".", "_");
				  if (typeof(metrics.timer_data[timer_key]["upper_" + normalizedPercentile]) == 'undefined') {
				    continue;
				  }
					this.add_point_to_message(stackdriverMessage, {
						name : timer_key + "." + normalizedPercentile + "_pct",
						value : metrics.timer_data[timer_key]["upper_" + normalizedPercentile],
						collected_at: timestamp
					});
				}
			}
		}
	}

	if (this.sendSets) {
		for (set_key in metrics.sets) {
			if (set_key.match(internalMetricsPrefix) != null) {
				if (this.debug) {
					util.log("Skipping internal metric " + set_key);
				}
				continue;
			} else {
				if (this.debug) {
					util.log("Found set " + set_key);
				}
				this.add_point_to_message(stackdriverMessage, {
					name : set_key + ".count",
					value : metrics.sets[set_key].values().length,
					collected_at: timestamp
				});
			}
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

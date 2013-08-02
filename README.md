stackdriver-statsd-backend
==========================

Backend plugin for [statsd](https://github.com/etsy/statsd) to publish output to the [Stackdriver](http://www.stackdriver.com) custom metrics API over HTTPS.

### Installation

Install [statsd](https://github.com/etsy/statsd) normally.  We'll call the root directory of the statsd install ```$STATSD_HOME```

From your ```$STATSD_HOME``` directory run ```$ npm install stackdriver-statsd-backend``` will install this module into the appropriate place, and the configurations below will reference it as a backend.

For now you can pull [stackdriver.js](https://github.com/Stackdriver/stackdriver-statsd-backend/blob/master/lib/stackdriver.js) and put it in the backends directory of your statsd and it will
be configurable like below.

### Configuration Examples

To set up the Stackdriver backend, you need a [Stackdriver account](https://www.stackdriver.com/signup/) and [API key](https://app.stackdriver.com/settings/).  Everything else is optional.  Any of the configurations below can be put into a stackdriverConfig.js and used as a statsd config on startup.

```$ bin/statsd stackdriverConfig.js```

Please set flushInterval to 1 minute (60000 milliseconds) or more, as that is the highest frequency we support at this time (another good reason to use this statsd plugin).

```js
{
    flushInterval: 60000,
    backends: [ "stackdriver-statsd-backend"], 
    stackdriver: {
        apiKey: "YOUR_API_KEY_HERE"
    }
}
```

To associate the metrics with a particular instance (such as the one statsd is running on) add the source parameter to your configuration.  The custom metrics generated will be associated with that AWS or Rackspace Cloud instance. For AWS, instance ID is in the form i-00000000.

```js
{
    flushInterval: 60000,
    backends: [ "stackdriver-statsd-backend"], 
    stackdriver: {
        apiKey: "YOUR_API_KEY_HERE",
        source: "AWS Instance ID here"
    }
}
```

To output additional logging information, add the debug parameter set to true.  It will be more verbose, and can be helpful to tell what exactly is being sent to [Stackdriver](http://www.stackdriver.com).

```js
{
    flushInterval: 60000,
    backends: [ "stackdriver-statsd-backend"], 
    stackdriver: {
        apiKey: "YOUR_API_KEY_HERE",
        debug: "true"
    }
}
```

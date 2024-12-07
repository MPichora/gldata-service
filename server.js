const express = require('express');
const axios = require('axios');
const cors = require('cors');
const expressCache = require('express-cache-middleware');
const cacheManager = require('cache-manager');
const conditionLocations = require('./conditionLocations.json');

const cacheMiddleware = new expressCache(
	cacheManager.caching({
		store: 'memory', max: 100, ttl: 3600
	})
);

const CORS_PROXY_PORT = 5000;

var app = express();

app.use(cors());
app.use(express.static('src/pages'));
cacheMiddleware.attach(app);


function parseFloatArrAndScale(scale, raw_str) {
	var floatarr = [];
	raw_str.split(',').forEach(str => {
		if(str.length > 0) {
			floatarr.push(scale * parseFloat(str));
		}
	});
	return floatarr;
}

function compute_score(series, ideal_wind_dir) {
	const wind = series[0].data;
	const wave = series[1].data;
	const temp = series[2].data;
	const gust = series[3].data2;
	const deg = series[4].data;

	const sma_length=5;
	var wind_sma = { sum: 0, cnt: 0 };
	var wave_sma = { sum: 0, cnt: 0 };
	var resArr = [];
	for(var i=0; i< wind.length; i++) {
		// wind sma calculation
		if(wind[i] !== null) {
			wind_sma.sum += wind[i];
			wind_sma.cnt += 1;
		}
		if(i>=sma_length) {
			if(wind[i-sma_length] !== null) {
				wind_sma.sum -= wind[i-sma_length];
				wind_sma.cnt -= 1;
			}
		}
		const windsma = wind_sma.cnt>0 ? wind_sma.sum/wind_sma.cnt : null;
		// wave sma calculation
		if(wave[i] !== null) {
			wave_sma.sum += wave[i];
			wave_sma.cnt += 1;
		}
		if(i>=sma_length) {
			if(wave[i-sma_length] !== null) {
				wave_sma.sum -= wave[i-sma_length];
				wave_sma.cnt -= 1;
			}
		}
		const wavesma = wave_sma.cnt>0 ? wave_sma.sum/wave_sma.cnt : null;
		// wind score calculation
		var wind_fun = (x,y) => {
			var r = (x-y)/4;
			r = r>1 ? 1 : r;
			r = r>0.1 ? r : 0.1;
			return r;
		};
		var deg_fun = (d) => {
			var r = ideal_wind_dir-d;
			r = r<0 ? 0-r : r;
			r = 1.2 - r/360;
			return r/1.2;
		};
		const wind_score = deg_fun(deg[i]) * wind_fun(12,wind[i]) * wind_fun(12,windsma) * wind_fun(8,gust[i]);
		// temp score calculation
		const temp_d = (temp[i]-15) * (temp[i]-15);
		const temp_score = (temp[i]+10) * (40-temp[i]) / (temp[i] == 15 ? 200 :(200>temp_d ? 200: temp_d )) / 3.125;
		// wave score calculation
		var wave_fun = (x) => {
			var r = (25 - 16*x*x)/5;
			r = r>5 ? 5 : r;
			r = r>0 ? r : 0;
			return r;
		};
		const wave_score = wave_fun(wave[i]) * wave_fun(wavesma) / 25;
		// final score calculation
		const final_score =  temp_score * wave_score * wind_score; 
		resArr.push(final_score);
	}
	return resArr;
}

function convertTime_(str) {
	const tfields = str.split('-');
	if(tfields.length==3) {
		const lfields = tfields[2].split(' ');
		tfields[2] = lfields[0];
		tfields.push(lfields[1]);
	}
	const dstr = '20' + tfields[0] + '-' + tfields[1] + '-' + tfields[2] + 'T' + tfields[3].replace('Z',':00:00.000Z');
	return Date.parse(dstr);
}

function owm_parseVals(onecall,forecast,timestart,timelast, onecall_accfun, forecast_accfun) {
	var ts = timestart/1000; // seconds epoch
	const te = timelast/1000;
	var timeArr = [];
	var resArr = [];
	var n = 0;
	while(ts<=te) {
		timeArr.push(ts);
		resArr.push(null); // put nulls in for everything
		ts += 3600; // 1h
		n++;
	}
	//console.log("pV ", n);
	var idx=0;
	onecall.hourly.forEach(function (hrd,i) {
		while(timeArr[idx] < hrd.dt && idx<n) {
			idx++;
		}
		if(hrd.dt == timeArr[idx]) {
			resArr[idx] = onecall_accfun(hrd);
		}
	});
	idx=0;
	forecast.list.forEach(function (ard,i) {
		while(timeArr[idx] < ard.dt && idx<n) {
			idx++;
		}
		if(ard.dt == timeArr[idx]) {
			resArr[idx] = forecast_accfun(ard);
		}
	});
	// ok now interpolate ;-)
	var last = null;
	for(var i=0; i< n; i++) {
		if(resArr[i] === null && last !== null) {
			var nxt = null;	
			var nxt_dist = null;
			if(i+1<n && resArr[i+1] !== null) {
				nxt = resArr[i+1];
				nxt_dist = 1;
			} else if(i+2<n ** resArr[i+2] !== null) {
				nxt = resArr[i+2];
				nxt_dist = 2;
			}
			resArr[i] = nxt === null ?  null
				: (nxt_dist == 1 ? (last+nxt)/2 : (2*last + nxt)/3);
		}
		last=resArr[i];
	}
	//console.log("pV res: ", resArr);
	return resArr;
}

function get_owm_api_key() {
	const args = process.argv.slice(2);
	var ak = process.env.OWMKEY;
	args.forEach(function(x,i) {
		if(x.startsWith('owmkey:') ) {
			ak = x.split(':')[1];
		}
	});
	return ak
}

app.get('/conditionLocations.json', function(req,resp) {
	console.log('GET on conditionLocations.json from source URIs');
	var cls = conditionLocations;
	if(req.query.namekey) {
		var cl = conditionLocations.find(el => el.name === req.query.namekey);
		if(cl) {
			cls = [ cl ];
		}
	}
	resp.status(200).send(conditionLocations);
});

const owm_key = get_owm_api_key();

function getLocationInfo(namekey) {
	var cl = conditionLocations.find( el => el.name === namekey);
	if(cl) {
		console.log("found record for " + namekey);
	} else {
		console.log("record for " + namekey + " was not found");
	}
	const glerl_base_url = 'https://www.glerl.noaa.gov/emf/waves/WW3/point/wave';
	const glerl_location_suffix = cl.suffix || '-79.79-43.31.txt';
        cl.glerl_time = glerl_base_url + 'time' + glerl_location_suffix;
        cl.glerl_wind = glerl_base_url + 'wind' + glerl_location_suffix;
        cl.glerl_hgt = glerl_base_url + 'hgt' + glerl_location_suffix;
	const lat = cl.coord[0] || 43.2795; // default to burlington
	const lon = cl.coord[1] || -79.7310;
	//owm urls
	const owm_weather_base_url = 'https://api.openweathermap.org/data/2.5/';
	const owm_weather_api1 = 'onecall?lat=' + lat + '&lon=' + lon + '&units=metric&appid=' + owm_key;
	const owm_weather_api2 = 'forecast?lat=' + lat + '&lon=' + lon + '&units=metric&appid=' + owm_key;	
	cl.owm_onecall = owm_weather_base_url + owm_weather_api1;
	cl.owm_forecast = owm_weather_base_url + owm_weather_api2;
	//open-meteo urls
	const om_weather_base_url = 'https://api.open-meteo.com/v1/forecast?';
	const om_weather_api_tail = '&hourly=temperature_2m,apparent_temperature,wind_speed_10m,'
		+'wind_direction_10m,wind_gusts_10m&models=best_match&forecast_days=10';
	const om_weather_api = 'latitude=' + lat + '&longitude=' + lon + om_weather_api_tail;
	cl.om_onecall = om_weather_base_url + om_weather_api;
	// ideal weather direction
	cl.iwd = parseInt(cl.ideal_wind_dir) || 270;
	return cl;
}

app.get('/windwaves.json', function (req,resp) {
	console.log('GET on windwaves.json from source URIs');
	const cl = getLocationInfo(req.query.namekey || 'Burlington');
	axios.all([
		axios.get( cl.glerl_time),
		axios.get( cl.glerl_wind),
		axios.get( cl.glerl_hgt) 
	]).then(axios.spread((time, wind, hgt) => {
		//console.log('time: ', time.data);
		//console.log('wind: ', wind.data);
		//console.log('hgt: ', hgt.data);
		const time_str_arr = time.data.split(',');
		const timestart = convertTime_(time_str_arr[0]);
		console.log('date start ' + time_str_arr[0] + ' -> ' + timestart);
		const timenext = convertTime_(time_str_arr[1]);
		const timeinterval = timenext - timestart;
		const metric_series = [{
			name: 'GLERL Wind (m/s)',
			data: parseFloatArrAndScale(1.0, wind.data)
		}, {
			name: 'GLERL Waves (m)',
			data: parseFloatArrAndScale(1.0, hgt.data)
		}];
		const imperial_series = [{
			name: 'GLERL Wind (knots)',
			data: parseFloatArrAndScale(1.9438, wind.data)
		}, {
			name: 'GLERL Waves (ft)',
			data: parseFloatArrAndScale(3.281, hgt.data)
		}];
		resp.status(200).send({
			pointInterval: timeinterval,
			pointStart: timestart,
			metricSeries: metric_series,
			imperialSeries: imperial_series
		});
	})).catch( err => resp.send(err));
});

function om_trim_scale_data(data, scaleby, startat, endat) {
	var rArr = [];
    for(var i=startat; i<=endat; i++) {
		if(i<0) {
			rArr.push(data[0]*scaleby);
		} else if(i>data.length-1) {
			rArr.push(data[data.length-1]*scaleby);
		} else {
			rArr.push(data[i]*scaleby)
		}
	}
	return rArr;
}

app.get('/weather.json', function (req,resp) {
	console.log('GET on weather.json from source URIs');
	const cl = getLocationInfo(req.query.namekey || 'Burlington');
	//console.log('get on ' + cl.om_onecall);
	axios.get( cl.om_onecall ).then( (onecall) => {
		const timestart = Date.parse(onecall.data.hourly.time[0] + 'Z') ; // expect msec
		console.log('date start -> ' + timestart);
		console.log('om tz ' + onecall.data.timezone);
		//const timenext = convertTime_(time_str_arr[1]);
		const timeinterval = 1000*3600; //1hr in msec
		const timelast = (onecall.data.hourly.time.length-1)*timeinterval + timestart; // expect msec
		console.log('date last -> ' + timelast);
		var imperial_series = [];
		imperial_series.push({
			name: 'OM Temp (C)',
			data: onecall.data.hourly.temperature_2m,
			name2: 'OM Apparent Temp (C)',
			data2: onecall.data.hourly.apparent_temperature_2m,
		});
		const om_startat = 0;
		const om_endat = onecall.data.hourly.time.length-1;
		imperial_series.push({
			name: 'OM Wind (m/s)',
			data: om_trim_scale_data(onecall.data.hourly.wind_speed_10m,0.27778,om_startat,om_endat),
			name2: 'OM Gusts (m/s)',
			data2: om_trim_scale_data(onecall.data.hourly.wind_gusts_10m,0.27778,om_startat,om_endat),
		});
		imperial_series.push({
			name: 'OM Wind Direction (deg)',
			data: onecall.data.hourly.wind_direction_10m,
		});
		resp.status(200).send({
			pointInterval: timeinterval,
			pointStart: timestart,
			imperialSeries: imperial_series,
		});

	}).catch( err => resp.send(err));
});

app.get('/owm_weather.json', function (req,resp) {
	console.log('GET on owm_weather.json from source URIs');
	const cl = getLocationInfo(req.query.namekey || 'Burlington');
	axios.all([
		axios.get( cl.owm_onecall ),
		axios.get( cl.owm_forecast )
	]).then(axios.spread((onecall, forecast) => {
		const timestart = onecall.data.hourly[0].dt * 1000; // expect msec
		console.log('date start -> ' + timestart);
		console.log('owm ' + onecall.data.timezone + ', ' + forecast.data.cnt);
		//const timenext = convertTime_(time_str_arr[1]);
		const timeinterval = 1000*3600; //1hr in msec
		const timelast = forecast.data.list[forecast.data.list.length-1].dt * 1000; // expect msec
		console.log('date last -> ' + timelast);
		var imperial_series = [];
		imperial_series.push({
			name: 'OWM Temp (C)',
			data: owm_parseVals(onecall.data,forecast.data,timestart,timelast, (js) => js.temp, (js) => js.main.temp),
			name2: 'OWM RealFeel Temp (C)',
			data2: owm_parseVals(onecall.data,forecast.data,timestart,timelast, (js) => js.feels_like, (js) => js.main.feels_like)
		});
		imperial_series.push({
			name: 'OWM Wind (m/s)',
			data: owm_parseVals(onecall.data,forecast.data,timestart,timelast, (js) => js.wind_speed, (js) => js.wind.speed),
			name2: 'OWM Gusts (m/s)',
			data2: owm_parseVals(onecall.data,forecast.data,timestart,timelast, (js) => js.wind_gust, (js) => js.wind.gust)
		});
		imperial_series.push({
			name: 'OWM Wind Direction (deg)',
			data: owm_parseVals(onecall.data,forecast.data,timestart,timelast, (js) => js.wind_deg, (js) => js.wind.deg),
		});
		resp.status(200).send({
			pointInterval: timeinterval,
			pointStart: timestart,
			imperialSeries: imperial_series,
		});
	})).catch( err => resp.send(err));
});

function fetch_weatherwindwaves(namekey) {
	const cl = getLocationInfo(namekey || 'Burlington');
    const ideal_wind_dir = cl.iwd;
    console.log("ideal wind dir is ", ideal_wind_dir);
	var p = axios.all([
		axios.get( cl.glerl_time ),
		axios.get( cl.glerl_wind ),
		axios.get( cl.glerl_hgt ),
		axios.get( cl.om_onecall )
	]).then(axios.spread((time, wind, hgt, onecall) => {
		const time_str_arr = time.data.split(',');
		const gl_timestart = convertTime_(time_str_arr[0]);
		console.log('waves date start ' + time_str_arr[0] + ' -> ' + gl_timestart);
		const timenext = convertTime_(time_str_arr[1]);
		const timeinterval = timenext - gl_timestart;
		var imperial_series = [{
			name: 'GLERL Wind (knots)',
			data: parseFloatArrAndScale(1.9438, wind.data)
		}, {
			name: 'GLERL Waves (ft)',
			data: parseFloatArrAndScale(3.281, hgt.data)
		}];
		const gl_timelast = gl_timestart + timeinterval*(imperial_series[0].data.length - 1);

		console.log('om tz' + onecall.data.timezone);
		const om_timestart = Date.parse(onecall.data.hourly.time[0] + 'Z') ; // expect msec
		const om_timelast = (onecall.data.hourly.time.length-1)*timeinterval + om_timestart; // expect msec
		console.log('om date start -> ' + om_timestart + ' gl date start -> ' + gl_timestart);
		console.log('om date last -> ' + om_timelast + ' gl date last -> ' + gl_timelast);
		// these relative indices can be negative (by design) the trim function fixes that.
		// they can also be too large vs the underlying weather data array (also trim does it)
		const om_startat = ((gl_timestart - om_timestart)/timeinterval);
		const om_endat = ((gl_timelast - gl_timestart)/timeinterval) + om_startat;
		imperial_series.push({
			name: 'OM Temp (C)',
			data: om_trim_scale_data(onecall.data.hourly.temperature_2m,1.0,om_startat,om_endat),
			name2: 'OM Apparent Temp (C)',
			data2: onecall.data.hourly.apparent_temperature_2m,
		});
		imperial_series.push({
			name: 'OM Wind (m/s)',
			data: om_trim_scale_data(onecall.data.hourly.wind_speed_10m,0.27778,om_startat,om_endat),
			name2: 'OM Gusts (m/s)',
			data2: om_trim_scale_data(onecall.data.hourly.wind_gusts_10m,0.27778,om_startat,om_endat),
		});
		imperial_series.push({
			name: 'OM Wind Direction (deg)',
			data: om_trim_scale_data(onecall.data.hourly.wind_direction_10m,1.0,om_startat,om_endat),
		});

		const scores = compute_score(imperial_series, ideal_wind_dir);
		imperial_series.push({ // for debugging really
			name: 'score',
			data: scores
		});
		return {
			pointInterval: timeinterval,
			pointStart: gl_timestart,
			imperialSeries: imperial_series,
			scoreSeries: scores
		};
	}))
	return p;
}

app.get('/weatherwindwaves.json', function (req,resp) {
	console.log('GET on weatherwindwaves.json from source URIs');
	fetch_weatherwindwaves(req.query.namekey)
		.then( dataResponse => resp.status(200).send(dataResponse) )
		.catch( err => resp.send(err) );
});

app.get('/lakescores.json', function(req, resp) {
	console.log('GET on lakescores.json from source URIs');
	const cls = conditionLocations.filter(cl => cl.lake === req.query.lake);
	const ncls = cls.length;
	var rl = [];
	var hitError = null;
	var pointInterval = null;
	var pointStart = null;
	var promises = [];
	for(var i=0; i<ncls; i++) {
		promises.push(fetch_weatherwindwaves(cls[i].name));
	}
	Promise.all(promises)
		.then(
			rls => {
				rls.forEach((r,i) => {
					rl.push({ name: cls[i].name, scoreSeries: r.scoreSeries });
					pointInterval = r.pointInterval;
					pointStart = r.pointStart;
				});
				const threshold = req.query.threshold || 0.50;
				var result = {
					pointInterval: pointInterval,
					pointStart: pointStart,
					goodScores: []
				};
				if(rl.length>0) {
					var ts = pointStart;
					for(var j=0; j<rl[0].scoreSeries.length; j++) {
						var goodones = [];
						for(var k=0; k< rl.length; k++) {
							if(rl[k].scoreSeries[j]>threshold) {
								goodones.push(rl[k].name);
							}
						}
						if(goodones.length>0) {
							result.goodScores.push({ ts: ts, good: goodones });
						}
						ts += pointInterval;
					}
				}
				resp.status(200).send(result);
			});
		//.error( e => resp.send(e));
			
});

app.set('port', process.env.PORT || CORS_PROXY_PORT);

app.listen(app.get('port'), function () {
	console.log('Proxy server is listening on port ' + app.get('port'));
});


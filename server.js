const express = require('express');
const axios = require('axios');
const cors = require('cors');
const expressCache = require('express-cache-middleware');
const cacheManager = require('cache-manager');

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

function parseVals(onecall,forecast,timestart,timelast, onecall_accfun, forecast_accfun) {
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

app.get('/windwaves.json', function (req,resp) {
	console.log('GET on windwaves.json from source URIs');
	const base_url = 'https://www.glerl.noaa.gov/emf/waves/WW3/point/wave';
	const location_suffix = '-79.79-43.31.txt';
	axios.all([
		axios.get( base_url + 'time' + location_suffix),
		axios.get( base_url + 'wind' + location_suffix),
		axios.get( base_url + 'hgt'  + location_suffix) 
	]).then(axios.spread((time, wind, hgt) => {
		console.log('time: ', time.data);
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

const owm_key = get_owm_api_key();

app.get('/weatherwindwaves.json', function (req,resp) {
	console.log('GET on weatherwaves.json from source URIs');
	const glerl_base_url = 'https://www.glerl.noaa.gov/emf/waves/WW3/point/wave';
	const glerl_location_suffix = req.query.suffix || '-79.79-43.31.txt';
  const ideal_wind_dir = parseInt(req.query.iwd || '270');
  console.log("ideal wind dir is ", ideal_wind_dir);
	const weather_base_url = 'https://api.openweathermap.org/data/2.5/'
	const weather_api1 = 'onecall?lat=43.2795&lon=-79.7310&units=metric&appid=' + owm_key;
	const weather_api2 = 'forecast?lat=43.2795&lon=-79.7310&units=metric&appid=' + owm_key;
	axios.all([
		axios.get( glerl_base_url + 'time' + glerl_location_suffix),
		axios.get( glerl_base_url + 'wind' + glerl_location_suffix),
		axios.get( glerl_base_url + 'hgt'  + glerl_location_suffix),
		axios.get( weather_base_url + weather_api1 ),
		axios.get( weather_base_url + weather_api2 )
	]).then(axios.spread((time, wind, hgt, onecall, forecast) => {
		const time_str_arr = time.data.split(',');
		const timestart = convertTime_(time_str_arr[0]);
		console.log('date start ' + time_str_arr[0] + ' -> ' + timestart);
		console.log('owm ' + onecall.data.timezone + ', ' + forecast.data.cnt);
		const timenext = convertTime_(time_str_arr[1]);
		const timeinterval = timenext - timestart;
		var imperial_series = [{
			name: 'GLERL Wind (knots)',
			data: parseFloatArrAndScale(1.9438, wind.data)
		}, {
			name: 'GLERL Waves (ft)',
			data: parseFloatArrAndScale(3.281, hgt.data)
		}];
		const timelast = timestart + timeinterval*(imperial_series[0].data.length - 1);
		imperial_series.push({
			name: 'OWM Temp (C)',
			data: parseVals(onecall.data,forecast.data,timestart,timelast, (js) => js.temp, (js) => js.main.temp),
			name2: 'OWM RealFeel Temp (C)',
			data2: parseVals(onecall.data,forecast.data,timestart,timelast, (js) => js.feels_like, (js) => js.main.feels_like)
		});
		imperial_series.push({
			name: 'OWM Wind (m/s)',
			data: parseVals(onecall.data,forecast.data,timestart,timelast, (js) => js.wind_speed, (js) => js.wind.speed),
			name2: 'OWM Gusts (m/s)',
			data2: parseVals(onecall.data,forecast.data,timestart,timelast, (js) => js.wind_gust, (js) => js.wind.gust)
		});
		imperial_series.push({
			name: 'OWM Wind Direction (deg)',
			data: parseVals(onecall.data,forecast.data,timestart,timelast, (js) => js.wind_deg, (js) => js.wind.deg),
		});
		const scores = compute_score(imperial_series, ideal_wind_dir);
		imperial_series.push({ // for debugging really
			name: 'score',
			data: scores
		});
		resp.status(200).send({
			pointInterval: timeinterval,
			pointStart: timestart,
			imperialSeries: imperial_series,
			scoreSeries: scores
		});
	})).catch( err => resp.send(err));
});

app.set('port', process.env.PORT || CORS_PROXY_PORT);

app.listen(app.get('port'), function () {
	console.log('Proxy server is listening on port ' + app.get('port'));
});


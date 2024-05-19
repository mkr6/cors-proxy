//========================================================================================================================
//
//	IMPORTS
//
//========================================================================================================================

const http = require("http");
const https = require("https");
const fetch = require("node-fetch");
const { curly } = require("node-libcurl");
const fs = require("fs");
const on_death = require("death");
const { exit } = require("process");

//========================================================================================================================



//========================================================================================================================
//
// CONFIG
//
//========================================================================================================================

var config = {
	server_port: 42069, // only for http

	rpc_url: "https://testnet-dmc.mydefichain.com:20551",
//	rpc_url: "https://changinode1.defiserver.de",

	use_https: false, // must provide own SSL keyfiles and uncomment https_options
	// https_options: {
	// 	key: fs.readFileSync(__dirname + "/ssl/ssl_stuff.key.pem"),
	// 	cert: fs.readFileSync(__dirname + "/ssl/ssl_stuff.cert.pem")
	// },

	use_curl: false, // if false --> use fetch / local changi RPC node needs curl

	show_requests: false,

	enable_rate_limiting: false,
	rate_limiting_timeframe: 1, // seconds
	rate_limiting_max_requests: 10,
}

//========================================================================================================================



//========================================================================================================================
//
//	HELPER FUNCTIONS & ERROR HANDLING
//
//========================================================================================================================

const log = {
	colors: {
		reset: "\x1B[0m",
		bright: "\x1B[1m",
		dim: "\x1B[2m",
		underscore: "\x1B[4m",
		blink: "\x1B[5m",
		reverse: "\x1B[7m",
		hidden: "\x1B[8m",

		fg: {
			black: "\x1B[30m",
			red: "\x1B[31m",
			green: "\x1B[32m",
			yellow: "\x1B[33m",
			blue: "\x1B[34m",
			magenta: "\x1B[35m",
			cyan: "\x1B[36m",
			white: "\x1B[37m",
			grey: "\x1B[1m\x1B[30m" // bright + fg.black
		},

		bg: {
			black: "\x1B[40m",
			red: "\x1B[41m",
			green: "\x1B[42m",
			yellow: "\x1B[43m",
			blue: "\x1B[44m",
			magenta: "\x1B[45m",
			cyan: "\x1B[46m",
			white: "\x1B[47m"
		}
	},

	file: "log.txt",


	colors_test: function (_test_string = "bla 123 ### ABC ** [1234566]") {
		var dim_bright = ["dim", "bright"];

		for (var [k1, v1] of Object.entries(log.colors.bg))
			for (var [k2, v2] of Object.entries(log.colors.fg))
				for (var i = 0; i < dim_bright.length; i++)
					log.out(`${log.colors.fg.grey}BG:${log.colors.reset} ${k1.padStart(7, " ")} ${log.colors.fg.grey}FG:${log.colors.reset} ${k2.padStart(7, " ")} ${log.colors.fg.grey}[${dim_bright[i].padStart(6, " ")}]${log.colors.reset}    ${log.colors[dim_bright[i]] + v1 + v2}${_test_string}${log.colors.reset}`);
	},

	timestamp: function () {
		var d = new Date();

		var month = String(d.getMonth() + 1).padStart(2, "0");
		var date = String(d.getDate(), 2).padStart(2, "0");
		var hour = String(d.getHours(), 2).padStart(2, "0");
		var min = String(d.getMinutes(), 2).padStart(2, "0");
		var sec = String(d.getSeconds(), 2).padStart(2, "0");

		return `${this.colors.fg.yellow}[${date}.${month}. ${hour}:${min}:${sec}]${this.colors.reset}`;
	},

	to_file: function (_out, _newline = true) {
		fs.appendFileSync(this.file, _out.replace(/\x1B\[[0-9]*m/g, "") + (_newline ? "\r\n" : ""));
	},

	in: function (_regex_mask, _timestamp = false) {
		while (true) {
			var out = `${_timestamp ? this.timestamp() : " ".repeat(17)} > `;
			this.to_file(out, false);

			var result = prompt(out);
			this.to_file(result);

			if ((_regex_mask != undefined) && (_regex_mask = new RegExp(_regex_mask)) && !_regex_mask.test(result))
				this.out(`invalid input, not matching ${_regex_mask.toString()}`, false);
			else
				break;
		}

		return result;
	},

	out: function (_out, _timestamp = true, _newline = true) {
		if (typeof (_out) == "object")
			_out = JSON.stringify(_out);

		if (_timestamp)
			_out = `${this.timestamp()} ${_out}`;
		else
			_out = `${" ".repeat(17)} ${_out}`

		if (_newline)
			console.log(_out);
		else
			process.stdout.write(_out);

		this.to_file(_out);
	},

	br: function (_color = log.colors.fg.yellow, _char = "=") {
		var _out = _char.repeat(100);

		console.log(_color + _out + log.colors.reset);
		this.to_file(_out);
	}
};

process.on("uncaughtException", function (_err) {
	log.out(log.colors.bg.red + "UNCAUGHT ERROR:" + log.colors.reset);
	log.out(log.colors.fg.black + log.colors.bright + _err.stack.replace(/\n/g, `\n${" ".repeat(18)}`) + log.colors.reset, false);

	//
	exit(0);
	//
});

function deathy() {
	log.out(log.colors.bg.red + "** CTRL+C --> hard exit **" + log.colors.reset);
	exit(0);
}
on_death(function (_signal, _error) {
	deathy();
});

function show_toggle_msg() {
	log.out(log.colors.fg.cyan + (config.show_requests ? "Showing" : "Hiding") + " requests (press [SPACE] to toggle)" + log.colors.reset);
}

var stdin = process.stdin;
stdin.setRawMode(true);
stdin.resume();
stdin.setEncoding("utf8");

stdin.on("data", function (key) {
	if (key == "\u0003")
		deathy();

	if (key == " ") {
		config.show_requests = !config.show_requests;
		show_toggle_msg();
	}
});

//========================================================================================================================



//========================================================================================================================
//
//	HTTP SERVER
//
//========================================================================================================================

var request_id = 0;
var rate_limiting = {};
var hitblock_last_hit = 0;
var hitblock_timeframe = 3;

function return_json(_response, _json) {
	_response.statusCode = 200;
	_response.setHeader("Content-Type", "application/json");
	// _response.setHeader("Access-Control-Allow-Origin", "*");
	// _response.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
	_response.end(JSON.stringify(_json));
}

async function start_server() {

	var server_func = async function (request, response) {
		request_id++;

		try {
			var user_ip = request.headers["cf-connecting-ip"];
			if (user_ip == undefined)
				user_ip = request.connection.remoteAddress;

			response.setHeader("Access-Control-Allow-Origin", "*");
			response.setHeader("Access-Control-Allow-Headers", "authorization, content-type");

			//--------------------------------------------------------------------------------------------------------------------
			// Rate limiting
			//--------------------------------------------------------------------------------------------------------------------
			if (config.enable_rate_limiting) {
				var now = Date.now() / 1000;
				if (rate_limiting[user_ip] == undefined)
					rate_limiting[user_ip] = { last_hit: now, hits_since: 0 };

				if (now >= (rate_limiting[user_ip].last_hit + config.rate_limiting_timeframe)) {
					rate_limiting[user_ip].last_hit = now;
					rate_limiting[user_ip].hits_since = 0;
				}

				rate_limiting[user_ip].hits_since++;

				if (rate_limiting[user_ip].hits_since > config.rate_limiting_max_requests) {
					log.out(`RATE LIMITED: ${user_ip}`);
					response.statusCode = 429;
					response.end();
					return;
				}
			}
			//--------------------------------------------------------------------------------------------------------------------

			//--------------------------------------------------------------------------------------------------------------------
			// Get data from request body
			//--------------------------------------------------------------------------------------------------------------------
			var buffers = [];
			for await (const chunk of request)
				buffers.push(chunk);

			var req_data = Buffer.concat(buffers).toString();
			try {
				req_data = JSON.parse(req_data);
			} catch {
				req_data = {};
			}
			//--------------------------------------------------------------------------------------------------------------------

			//--------------------------------------------------------------------------------------------------------------------
			// Request processing
			//--------------------------------------------------------------------------------------------------------------------
			// filter empty requests to minimize load on rpc
			if (Object.entries(req_data).length == 0) {
				var err_obj = { "jsonrpc": "2.0", "error": { "code": -32600, "message": "invalid request" }, "id": null };
				return_json(response, err_obj);
				return;
			}

			config.show_requests ? log.out(`${log.colors.bright} in>${log.colors.reset} ${log.colors.fg.yellow + log.colors.bright}[${String(request_id).padStart(7, " ")}]${log.colors.reset} ${log.colors.fg.black + log.colors.bright}[${user_ip}] ${JSON.stringify(req_data)}${log.colors.reset}`) : null;

			try {
				var fetch_response;
				var fetch_data
				var http_status;

				var now = Date.now() / 1000;
				if (now >= (hitblock_last_hit + hitblock_timeframe)) {
					hitblock_last_hit = 0;

					if (config.use_curl) {
						const { statusCode, data } = await curly.post(config.rpc_url, {
							httpHeader: ['Content-Type: application/json'],
							postFields: JSON.stringify(req_data),
						});

						http_status = statusCode;
						fetch_data = data;
					} else {
						fetch_response = await fetch(config.rpc_url, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(req_data),
						});

						http_status = fetch_response.status;

						if (fetch_response.ok)
							fetch_data = await fetch_response.text();
					}
				} else
					http_status = 503;

				//
				if (fetch_data && ((typeof fetch_data) == "string"))
					fetch_data = JSON.parse(fetch_data);

				if ((fetch_data != undefined) && (fetch_data.result == "0x"))
					fetch_data.result = "0x0000000000000000000000000000000000000000000000000000000000000000";
				//

				if (http_status == 503) {
					log.out(`${log.colors.fg.red}<out${log.colors.reset} ${log.colors.fg.yellow + log.colors.bright}[${String(request_id).padStart(7, " ")}]${log.colors.reset} ${log.colors.fg.black + log.colors.bright}[${user_ip}] HTTP 503 (RPC down?)${hitblock_last_hit ? ` [hitblock ${hitblock_timeframe}s]` : ""}${log.colors.reset}`, !config.show_requests);

					if (!hitblock_last_hit)
						hitblock_last_hit = now;

					response.statusCode = 503;
					response.end();
					return;
				}

				return_json(response, fetch_data);

				config.show_requests ? log.out(`${log.colors.fg.green + log.colors.bright}<out${log.colors.reset} ${log.colors.fg.yellow + log.colors.bright}[${String(request_id).padStart(7, " ")}]${log.colors.reset} ${log.colors.fg.black + log.colors.bright}[${user_ip}] ${JSON.stringify(fetch_data)}${log.colors.reset}`) : null;
			} catch (_error) {
				log.out(`${log.colors.fg.red}<out${log.colors.reset} ${log.colors.fg.yellow + log.colors.bright}[${String(request_id).padStart(7, " ")}]${log.colors.reset} ${log.colors.fg.black + log.colors.bright}[${user_ip}] HTTP 500 (Uncaught error)${log.colors.reset}`, false);

				log.out(log.colors.fg.black + log.colors.bright + _error.stack.replace(/\n/g, `\n${" ".repeat(18)}`) + log.colors.reset, false);

				response.statusCode = 500;
				response.end();
			}
			//--------------------------------------------------------------------------------------------------------------------
		} catch (_error) {
			log.out(log.colors.fg.red + log.colors.bright + "Uncaught server error:" + log.colors.reset);
			log.out(log.colors.fg.black + log.colors.bright + _error.stack.replace(/\n/g, `\n${" ".repeat(18)}`) + log.colors.reset, false);
		}
	};

	var server_call;
	if (!config.use_https)
		server_call = http.createServer(server_func);
	else {
		config.server_port = 443;
		server_call = https.createServer(config.https_options, server_func);
	}

	server_call.listen(config.server_port, "0.0.0.0", () => {
		log.out(`HTTP${config.use_https ? "S" : ""} server started @ port ${config.server_port}`);
	});
}

//========================================================================================================================



//========================================================================================================================
//
// MAIN
//
//========================================================================================================================

async function main() {
	show_toggle_msg();
	start_server();
}

main();

//========================================================================================================================

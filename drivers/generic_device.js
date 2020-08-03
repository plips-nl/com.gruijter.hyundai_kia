/*
Copyright 2020, Robin de Gruijter (gruijter@hotmail.com)

This file is part of com.gruijter.hyundai_kia.

com.gruijter.hyundai_kia is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.gruijter.hyundai_kia is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.gruijter.hyundai_kia. If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const Homey = require('homey');
const BlueLinky = require('bluelinky');
const Uvo = require('kuvork');
const GeoPoint = require('geopoint');
const util = require('util');
const ABRP = require('../abrp_telemetry');
const geo = require('../reverseGeo');
const convert = require('./temp_convert');

const setTimeoutPromise = util.promisify(setTimeout);

class CarDevice extends Homey.Device {

	// this method is called when the Device is inited
	async onInitDevice() {
		// this.log('device init: ', this.getName(), 'id:', this.getData().id);
		try {
			// init some stuff
			this.settings = await this.getSettings();
			this.vehicle = null;
			this.busy = false;
			this.watchDogCounter = 5;

			const options = {
				username: this.settings.username,
				password: this.settings.password,
				region: this.settings.region,
				pin: this.settings.pin,
				// vin: this.settings.vin,
				deviceUuid: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15), // 'homey',
			};
			if (this.ds.deviceId === 'bluelink') {
				this.client = new BlueLinky(options);
			} else this.client = new Uvo(options);

			this.client.on('ready', async (vehicles) => {
				[this.vehicle] = vehicles.filter((veh) => veh.vehicleConfig.vin === this.settings.vin);
				if (!this.busy && this.vehicle) this.log(util.inspect(this.vehicle.vehicleConfig, true, 10, true));
			});

			const abrpOptions = {
				apiKey: Homey.env.ABRP_API_KEY,
				userToken: this.settings.abrp_user_token,
			};
			this.abrp = new ABRP(abrpOptions);
			this.log(`ABRP enabled: ${this.settings.abrp_user_token.length > 5}`);

			// init listeners
			if (!this.allListeners) this.registerListeners();

			// wait 10 seconds to login
			await setTimeoutPromise(10 * 1000, 'waiting is done');
			this.startPolling(this.settings.pollInterval);

		} catch (error) {
			this.error(error);
		}
	}

	async doPoll(force) {
		try {
			if (this.watchDogCounter <= 0) {
				// restart the app here
				this.log('watchdog triggered, restarting app now');
				this.restartDevice();
				return;
			}
			if (this.busy) {
				this.log('still busy with previous poll...');
				this.watchDogCounter -= 1;
				return;
			}
			this.busy = true;
			await this.client.login();
			if (!this.vehicle || !this.vehicle.vehicleConfig) throw Error('not logged in');

			let status = this.lastStatus;
			let location = this.lastLocation;
			let odometer = this.lastOdometer;
			let newStatus = false;

			const forceRefresh = force
				|| (this.settings.pollIntervalForced && (this.settings.pollIntervalForced * 60 * 1000) < (Date.now() - this.lastRefresh))
				|| !status || !location || !odometer;

			if (!forceRefresh) {
				// get info from server
				status = await this.vehicle.status({
					refresh: false,
					parsed: false,
				});
			} else this.log('forcing refresh with car');

			// location = await this.vehicle.location();
			// console.log(location);

			// check if full status refresh is needed
			const sleepModeCheck = status ? (status.sleepModeCheck || (status.time !== this.lastStatus.time)) : null;
			if (sleepModeCheck) this.log('doing sleepModeCheck');

			const carActive = status ? (status.engine || status.airCtrlOn || status.defrost || sleepModeCheck) : null;
			const carJustActive = ((Date.now() - this.carLastActive) < 5 * 60 * 1000); // keep refreshing 5 minutes after car use or sleepModeCheck
			const batSoCGood = status ? (status.battery.batSoc > this.settings.batteryAlarmLevel) : true;

			this.liveData = forceRefresh || (batSoCGood && (carActive || carJustActive));

			if (this.liveData) {
				// get info from car
				status = await this.vehicle.status({
					refresh: true,
					parsed: false,
				});
				newStatus = true;
			}
			this.lastStatus = status;

			if (newStatus) {
				// get location and odo meter from car
				location = await this.vehicle.location();
				this.lastLocation = location;
				odometer = await this.vehicle.odometer();
				this.lastOdometer = odometer;
			}

			if (!this.lastRefresh) {
				this.log(util.inspect(status, true, 10, true));
				this.log(util.inspect(location, true, 10, true));
				this.log(util.inspect(odometer, true, 10, true));
			}
			this.lastRefresh = newStatus ? Date.now() : this.lastRefresh;
			this.carLastActive = carActive ? this.lastRefresh : this.carLastActive;

			// update ABRP telemetry
			if (this.liveData && (this.settings.abrp_user_token.length > 5)) {
				this.abrpTelemetry({ status, location, odometer });
			}

			// update capabilities and flows
			this.handleInfo({ status, location, odometer });

			this.watchDogCounter = 5;
			this.busy = false;
		} catch (error) {
			this.watchDogCounter -= 1;
			this.busy = false;
			this.error('Poll error', error.body || error);
		}
	}

	startPolling(interval) {
		this.log(`Start polling ${this.getName()} @ ${interval} minute interval.`);
		if (this.settings.pollIntervalForced) this.log(`Warning: forced polling is enabled @${this.settings.pollIntervalForced} minute interval.`);
		this.stopPolling();
		this.doPoll(true);
		this.intervalIdDevicePoll = setInterval(() => {
			this.doPoll();
		}, 1000 * 60 * interval);
	}

	stopPolling() {
		clearInterval(this.intervalIdDevicePoll);
	}

	restartDevice(delay) {
		// this.destroyListeners();
		this.stopPolling();
		setTimeout(() => {
			this.onInitDevice();
		}, delay || 1000 * 60 * 5);	// wait 5 minutes to reset possible auth failure
	}

	// this method is called when the Device is added
	async onAdded() {
		this.log(`Car added as device: ${this.getName()}`);
	}

	// this method is called when the Device is deleted
	onDeleted() {
		this.stopPolling();
		// this.destroyListeners();
		this.log(`Car deleted as device: ${this.getName()}`);
	}

	onRenamed(name) {
		this.log(`Meter renamed to: ${name}`);
	}

	// this method is called when the user has changed the device's settings in Homey.
	async onSettings(oldSettingsObj, newSettingsObj) { // , changedKeysArr) {
		this.log('settings change requested by user');
		this.log(newSettingsObj);
		// this.log(newSettingsObj);
		this.log(`${this.getName()} device settings changed`);


		this.restartDevice(1000);
		// do callback to confirm settings change
		return Promise.resolve(true);
	}

	// async destroyListeners() {
	// 	this.log('Destroying listeners');
	// 	if (this.capabilityInstances) {
	// 		Object.entries(this.capabilityInstances).forEach((entry) => {
	// 			// console.log(`destroying listener ${entry[0]}`);
	// 			entry[1].destroy();
	// 		});
	// 	}
	// 	this.capabilityInstances = {};
	// }

	setCapability(capability, value) {
		if (this.hasCapability(capability)) {
			// only update changed capabilities
			if (value !== this.getCapabilityValue(capability)) {
				this.setCapabilityValue(capability, value)
					.catch((error) => {
						this.log(error, capability, value);
					});
			}
		}
	}

	distance(location) {
		const lat1 = location.latitude;
		const lon1 = location.longitude;
		const lat2 = this.settings.lat;
		const lon2 = this.settings.lon;
		const from = new GeoPoint(Number(lat1), Number(lon1));
		const to = new GeoPoint(Number(lat2), Number(lon2));
		return Math.round(from.distanceTo(to, true) * 10) / 10;
	}

	async abrpTelemetry(info) {
		try {
			const {
				batteryCharge: charging,
				batteryStatus: soc,
			} = info.status.evStatus;
			const {
				latitude: lat,
				longitude: lon,
			} = info.location;
			const speed = info.location.speed.value;
			await this.abrp.send({
				lat, lon, speed, soc, charging,
			});
		} catch (error) {
			this.error(error);
		}
	}

	async handleInfo(info) {
		try {
			const {
				engine,
				doorLock: locked,
				airCtrlOn,
				defrost,
				trunkOpen,
				hoodOpen,
				doorOpen,
			} = info.status;
			const {
				batteryPlugin: charger, // charge cable connected 0=none 1=fast? 2=portable 3=normal station?
				batteryCharge: charging,
				batteryStatus: EVBatteryCharge,
			} = info.status.evStatus;
			// console.log(`pluggedIn: ${pluggedIn}`);
			const batteryCharge = info.status.battery.batSoc;
			const range = info.status.evStatus.drvDistance[0].rangeByFuel.totalAvailableRange.value;
			const targetTemperature = convert.getTempFromCode(info.status.airTemp.value);
			const alarmTirePressure = !!info.status.tirePressureLamp.tirePressureLampAll;

			const { speed } = info.location;
			const { odometer } = info;

			// calculated properties
			const closedLocked = locked && !trunkOpen && !hoodOpen
				&& Object.keys(doorOpen).reduce((closedAccu, door) => closedAccu || !doorOpen[door], true);
			const alarmEVBattery = EVBatteryCharge <= this.settings.EVbatteryAlarmLevel;
			const alarmBattery = batteryCharge <= this.settings.batteryAlarmLevel;
			const distance = this.distance(info.location);
			const locString = await geo.getCarLocString(info.location); // reverse ReverseGeocoding

			// detect changes
			const engineChange = engine !== this.getCapabilityValue('engine');
			const chargingChange = charging !== this.getCapabilityValue('charging');
			const climateControlChange = airCtrlOn !== this.getCapabilityValue('climate_control');
			const defrostChange = defrost !== this.getCapabilityValue('defrost');

			// update capabilities
			this.setCapability('measure_battery.EV', EVBatteryCharge);
			this.setCapability('measure_battery.12V', batteryCharge);
			this.setCapability('alarm_battery', alarmBattery || alarmEVBattery);
			this.setCapability('alarm_tire_pressure', alarmTirePressure);
			this.setCapability('locked', locked);
			this.setCapability('closed_locked', closedLocked);
			this.setCapability('target_temperature', targetTemperature);
			this.setCapability('defrost', defrost);
			this.setCapability('climate_control', airCtrlOn);
			this.setCapability('engine', engine);
			this.setCapability('charging', charging);
			this.setCapability('charger', charger.toString());
			this.setCapability('odometer', odometer.value);
			this.setCapability('range', range);
			this.setCapability('speed', speed.value);
			this.setCapability('location', locString);
			this.setCapability('distance', distance);
			this.setCapability('live_data', this.liveData);

			// update flow triggers
			const tokens = {};
			if (engineChange) {
				if (engine) {
					this.homey.flow.getDeviceTriggerCard('engine_true')
						.trigger(this, tokens)
						.catch(this.error);
				} else {
					this.homey.flow.getDeviceTriggerCard('engine_false')
						.trigger(this, tokens)
						.catch(this.error);
				}
			}
			if (chargingChange) {
				if (charging) {
					this.homey.flow.getDeviceTriggerCard('charging_true')
						.trigger(this, tokens)
						.catch(this.error);
				} else {
					this.homey.flow.getDeviceTriggerCard('charging_false')
						.trigger(this, tokens)
						.catch(this.error);
				}
			}
			if (climateControlChange) {
				if (airCtrlOn) {
					this.homey.flow.getDeviceTriggerCard('climate_control_true')
						.trigger(this, tokens)
						.catch(this.error);
				} else {
					this.homey.flow.getDeviceTriggerCard('climate_control_false')
						.trigger(this, tokens)
						.catch(this.error);
				}
			}
			if (defrostChange) {
				if (defrost) {
					this.homey.flow.getDeviceTriggerCard('defrost_true')
						.trigger(this, tokens)
						.catch(this.error);
				} else {
					this.homey.flow.getDeviceTriggerCard('defrost_false')
						.trigger(this, tokens)
						.catch(this.error);
				}
			}

		} catch (error) {
			this.error(error);
		}
	}

	// register capability listeners
	async registerListeners() {
		try {
			this.log('registering listeners');

			if (!this.allListeners) this.allListeners = {};

			// // unregister listeners first
			// const ready = Object.keys(this.allListeners).map((token) => Promise.resolve(Homey.ManagerFlow.unregisterToken(this.tokens[token])));
			// await Promise.all(ready);

			this.allListeners.forcepoll = this.homey.flow.getActionCard('force_poll');
			this.allListeners.forcepoll.registerRunListener(() => {
				this.doPoll(true);
				return true;
			});

			// capabilityListeners will be overwritten, so no need to unregister them

			this.registerCapabilityListener('locked', async (locked) => {
				let success;
				if (locked) {
					this.log('locking doors via app');
					success = await this.vehicle.lock();
				} else {
					this.log('unlocking doors via app');
					success = await this.vehicle.unlock();
				}
				await setTimeoutPromise(5 * 1000, 'waiting is done');
				this.doPoll(true);
				return Promise.resolve(success);
			});

			this.registerCapabilityListener('defrost', async (defrost) => {
				let success;
				if (defrost) {
					this.log('defrost start via app');
					success = await this.vehicle.start({
						defrost: true,
						windscreenHeating: true,
						temperature: this.getCapabilityValue('target_temperature') || 22,
					});
				} else {
					this.log('defrost stop via app');
					success = await this.vehicle.stop({
						defrost: false,
						windscreenHeating: false,
						temperature: this.getCapabilityValue('target_temperature') || 22,
					});
				}
				await setTimeoutPromise(5 * 1000, 'waiting is done');
				this.doPoll(true);
				return Promise.resolve(success);
			});

			this.registerCapabilityListener('climate_control', async (acOn) => {
				let success;
				if (acOn) {
					this.log('A/C on via app');
					success = await this.vehicle.start({
						// defrost: this.getCapabilityValue('defrost'),
						// windscreenHeating: true,
						temperature: this.getCapabilityValue('target_temperature') || 22,
					});
				} else {
					this.log('A/C off via app');
					success = await this.vehicle.stop({
						// defrost: this.getCapabilityValue('defrost'),
						// windscreenHeating: true,
						temperature: this.getCapabilityValue('target_temperature') || 22,
					});
				}
				await setTimeoutPromise(5 * 1000, 'waiting is done');
				this.doPoll(true);
				return Promise.resolve(success);
			});

			this.registerCapabilityListener('target_temperature', async (temp) => {
				// if (this.busy) {
				// 	console.log('ignoring temp set for now');
				// 	return Promise.resolve(false);
				// }
				this.log(`Changing temperature by app to ${temp}`);
				// let success;
				// if (this.getCapabilityValue('climate_control')) {
				// 	success = await this.vehicle.start({
				// 		// defrost: this.getCapabilityValue('defrost'),
				// 		// windscreenHeating: true,
				// 		temperature: temp || 22,
				// 	});
				// } else {
				// 	success = await this.vehicle.stop({
				// 		// defrost: this.getCapabilityValue('defrost'),
				// 		// windscreenHeating: true,
				// 		temperature: temp || 22,
				// 	});
				// }
				// this.doPoll(true);
				return Promise.resolve(false);
			});

			this.registerCapabilityListener('live_data', (liveData) => {
				if (liveData) {
					this.log('Switching on live data by app');
					this.doPoll(true);
				}
				// ADD STOP LIVE DATA HERE
				return Promise.resolve(true);
			});

			return Promise.resolve(this.listeners);
		} catch (error) {
			return Promise.resolve(error);
		}
	}

}

module.exports = CarDevice;

/*
// unparsed (door open, power on, start, after refresh on car):
status : {
	"airCtrlOn": true,
	"engine": true,
	"doorLock": false,
	"doorOpen": {
		"frontLeft": 0,
		"frontRight": 0,
		"backLeft": 0,
		"backRight": 0
	},
	"trunkOpen": false,
	"airTemp": {
		"value": "10H",
		"unit": 0,
		"hvacTempType": 1
	},
	"defrost": false,
	"acc": true,
	"evStatus": {
		"batteryCharge": false,
		"batteryStatus": 72,
		"batteryPlugin": 0,
		"remainTime2": {
			"etc1": {
				"value": 71,
				"unit": 1
			},
			"etc2": {
				"value": 620,
				"unit": 1
			},
			"etc3": {
				"value": 155,
				"unit": 1
			},
			"atc": {
				"value": 37,
				"unit": 1
			}
		},
		"drvDistance": [
			{
				"rangeByFuel": {
					"evModeRange": {
						"value": 334,
						"unit": 1
					},
					"totalAvailableRange": {
						"value": 334,
						"unit": 1
					}
				},
				"type": 2
			}
		],
		"reservChargeInfos": {
			"reservChargeInfo": {
				"reservChargeInfoDetail": {
					"reservInfo": {
						"day": [
							9
						],
						"time": {
							"time": "1200",
							"timeSection": 0
						}
					},
					"reservChargeSet": false,
					"reservFatcSet": {
						"defrost": false,
						"airTemp": {
							"value": "00H",
							"unit": 0
						},
						"airCtrl": 0,
						"heating1": 0
					}
				}
			},
			"offpeakPowerInfo": {
				"offPeakPowerTime1": {
					"starttime": {
						"time": "1200",
						"timeSection": 0
					},
					"endtime": {
						"time": "1200",
						"timeSection": 0
					}
				},
				"offPeakPowerFlag": 0
			},
			"reserveChargeInfo2": {
				"reservChargeInfoDetail": {
					"reservInfo": {
						"day": [
							9
						],
						"time": {
							"time": "1200",
							"timeSection": 0
						}
					},
					"reservChargeSet": false,
					"reservFatcSet": {
						"defrost": false,
						"airTemp": {
							"value": "00H",
							"unit": 0
						},
						"airCtrl": 0,
						"heating1": 0
					}
				}
			},
			"reservFlag": 0,
			"ect": {
				"start": {
					"day": 9,
					"time": {
						"time": "1200",
						"timeSection": 0
					}
				},
				"end": {
					"day": 9,
					"time": {
						"time": "1200",
						"timeSection": 0
					}
				}
			},
			"targetSOClist": [
				{
					"targetSOClevel": 100,
					"dte": {
						"rangeByFuel": {
							"evModeRange": {
								"value": 473,
								"unit": 1
							},
							"totalAvailableRange": {
								"value": 473,
								"unit": 1
							}
						},
						"type": 2
					},
					"plugType": 1
				}
			]
		}
	},
	"ign3": true,
	"hoodOpen": false,
	"steerWheelHeat": 0,
	"sideBackWindowHeat": 0,
	"tirePressureLamp": {
		"tirePressureLampAll": 0,
		"tirePressureLampFL": 0,
		"tirePressureLampFR": 0,
		"tirePressureLampRL": 0,
		"tirePressureLampRR": 0
	},
	"battery": {
		"batSoc": 84,
		"batState": 0
	},
	"time": "20200721101303"


// unparsed (power off, exit car, lock door, get server status):
status : {
	"airCtrlOn": false,
	"engine": false,
	"doorLock": true,
	"doorOpen": {
		"frontLeft": 0,
		"frontRight": 0,
		"backLeft": 0,
		"backRight": 0
	},
	"trunkOpen": false,
	"airTemp": {
		"value": "10H",
		"unit": 0,
		"hvacTempType": 1
	},
	"defrost": false,
	"acc": false,
	"evStatus": {
		"batteryCharge": false,
		"batteryStatus": 72,
		"batteryPlugin": 0,
		"remainTime2": {
			"etc1": {
				"value": 72,
				"unit": 1
			},
			"etc2": {
				"value": 620,
				"unit": 1
			},
			"etc3": {
				"value": 155,
				"unit": 1
			},
			"atc": {
				"value": 37,
				"unit": 1
			}
		},
		"drvDistance": [
			{
				"rangeByFuel": {
					"evModeRange": {
						"value": 333,
						"unit": 1
					},
					"totalAvailableRange": {
						"value": 333,
						"unit": 1
					}
				},
				"type": 2
			}
		],
		"reservChargeInfos": {
			"reservChargeInfo": {
				"reservChargeInfoDetail": {
					"reservInfo": {
						"day": [
							9
						],
						"time": {
							"time": "1200",
							"timeSection": 0
						}
					},
					"reservChargeSet": false,
					"reservFatcSet": {
						"defrost": false,
						"airTemp": {
							"value": "00H",
							"unit": 0
						},
						"airCtrl": 0,
						"heating1": 0
					}
				}
			},
			"offpeakPowerInfo": {
				"offPeakPowerTime1": {
					"starttime": {
						"time": "1200",
						"timeSection": 0
					},
					"endtime": {
						"time": "1200",
						"timeSection": 0
					}
				},
				"offPeakPowerFlag": 0
			},
			"reserveChargeInfo2": {
				"reservChargeInfoDetail": {
					"reservInfo": {
						"day": [
							9
						],
						"time": {
							"time": "1200",
							"timeSection": 0
						}
					},
					"reservChargeSet": false,
					"reservFatcSet": {
						"defrost": false,
						"airTemp": {
							"value": "00H",
							"unit": 0
						},
						"airCtrl": 0,
						"heating1": 0
					}
				}
			},
			"reservFlag": 0,
			"ect": {
				"start": {
					"day": 9,
					"time": {
						"time": "1200",
						"timeSection": 0
					}
				},
				"end": {
					"day": 9,
					"time": {
						"time": "1200",
						"timeSection": 0
					}
				}
			},
			"targetSOClist": [
				{
					"targetSOClevel": 100,
					"dte": {
						"rangeByFuel": {
							"evModeRange": {
								"value": 473,
								"unit": 1
							},
							"totalAvailableRange": {
								"value": 473,
								"unit": 1
							}
						},
						"type": 2
					},
					"plugType": 1
				}
			]
		}
	},
	"ign3": false,
	"hoodOpen": false,
	"transCond": true,
	"steerWheelHeat": 0,
	"sideBackWindowHeat": 0,
	"tirePressureLamp": {
		"tirePressureLampAll": 0,
		"tirePressureLampFL": 0,
		"tirePressureLampFR": 0,
		"tirePressureLampRL": 0,
		"tirePressureLampRR": 0
	},
	"battery": {
		"batSoc": 85,
		"batState": 0
	},
	"sleepModeCheck": true,
	"time": "20200721101842"
}

// unparsed (door open, power on, start):
status : {
	"airCtrlOn": false,
	"engine": false,
	"doorLock": true,
	"doorOpen": {
		"frontLeft": 0,
		"frontRight": 0,
		"backLeft": 0,
		"backRight": 0
	},
	"trunkOpen": false,
	"airTemp": {
		"value": "10H",
		"unit": 0,
		"hvacTempType": 1
	},
	"defrost": false,
	"acc": false,
	"evStatus": {
		"batteryCharge": false,
		"batteryStatus": 72,
		"batteryPlugin": 0,
		"remainTime2": {
			"etc1": {
				"value": 72,
				"unit": 1
			},
			"etc2": {
				"value": 620,
				"unit": 1
			},
			"etc3": {
				"value": 155,
				"unit": 1
			},
			"atc": {
				"value": 37,
				"unit": 1
			}
		},
		"drvDistance": [
			{
				"rangeByFuel": {
					"evModeRange": {
						"value": 334,
						"unit": 1
					},
					"totalAvailableRange": {
						"value": 334,
						"unit": 1
					}
				},
				"type": 2
			}
		],
		"reservChargeInfos": {
			"reservChargeInfo": {
				"reservChargeInfoDetail": {
					"reservInfo": {
						"day": [
							9
						],
						"time": {
							"time": "1200",
							"timeSection": 0
						}
					},
					"reservChargeSet": false,
					"reservFatcSet": {
						"defrost": false,
						"airTemp": {
							"value": "00H",
							"unit": 0
						},
						"airCtrl": 0,
						"heating1": 0
					}
				}
			},
			"offpeakPowerInfo": {
				"offPeakPowerTime1": {
					"starttime": {
						"time": "1200",
						"timeSection": 0
					},
					"endtime": {
						"time": "1200",
						"timeSection": 0
					}
				},
				"offPeakPowerFlag": 0
			},
			"reserveChargeInfo2": {
				"reservChargeInfoDetail": {
					"reservInfo": {
						"day": [
							9
						],
						"time": {
							"time": "1200",
							"timeSection": 0
						}
					},
					"reservChargeSet": false,
					"reservFatcSet": {
						"defrost": false,
						"airTemp": {
							"value": "00H",
							"unit": 0
						},
						"airCtrl": 0,
						"heating1": 0
					}
				}
			},
			"reservFlag": 0,
			"ect": {
				"start": {
					"day": 9,
					"time": {
						"time": "1200",
						"timeSection": 0
					}
				},
				"end": {
					"day": 9,
					"time": {
						"time": "1200",
						"timeSection": 0
					}
				}
			},
			"targetSOClist": [
				{
					"targetSOClevel": 0,
					"dte": {
						"rangeByFuel": {
							"evModeRange": {
								"value": 473,
								"unit": 1
							},
							"totalAvailableRange": {
								"value": 473,
								"unit": 1
							}
						},
						"type": 2
					},
					"plugType": 1
				}
			]
		}
	},
	"ign3": false,
	"hoodOpen": false,
	"transCond": true,
	"steerWheelHeat": 0,
	"sideBackWindowHeat": 0,
	"tirePressureLamp": {
		"tirePressureLampAll": 0,
		"tirePressureLampFL": 0,
		"tirePressureLampFR": 0,
		"tirePressureLampRL": 0,
		"tirePressureLampRR": 0
	},
	"battery": {
		"batSoc": 85,
		"batState": 0
	},
	"sleepModeCheck": true,
	"time": "20200721084418"
}

// unparsed (door open, power on, no start):
status : {
	"airCtrlOn": false,
	"engine": false,
	"doorLock": true,
	"doorOpen": {
		"frontLeft": 0,
		"frontRight": 0,
		"backLeft": 0,
		"backRight": 0
	},
	"trunkOpen": false,
	"airTemp": {
		"value": "10H",
		"unit": 0,
		"hvacTempType": 1
	},
	"defrost": false,
	"acc": false,
	"evStatus": {
		"batteryCharge": false,
		"batteryStatus": 72,
		"batteryPlugin": 0,
		"remainTime2": {
			"etc1": {
				"value": 72,
				"unit": 1
			},
			"etc2": {
				"value": 620,
				"unit": 1
			},
			"etc3": {
				"value": 155,
				"unit": 1
			},
			"atc": {
				"value": 37,
				"unit": 1
			}
		},
		"drvDistance": [
			{
				"rangeByFuel": {
					"evModeRange": {
						"value": 334,
						"unit": 1
					},
					"totalAvailableRange": {
						"value": 334,
						"unit": 1
					}
				},
				"type": 2
			}
		],
		"reservChargeInfos": {
			"reservChargeInfo": {
				"reservChargeInfoDetail": {
					"reservInfo": {
						"day": [
							9
						],
						"time": {
							"time": "1200",
							"timeSection": 0
						}
					},
					"reservChargeSet": false,
					"reservFatcSet": {
						"defrost": false,
						"airTemp": {
							"value": "00H",
							"unit": 0
						},
						"airCtrl": 0,
						"heating1": 0
					}
				}
			},
			"offpeakPowerInfo": {
				"offPeakPowerTime1": {
					"starttime": {
						"time": "1200",
						"timeSection": 0
					},
					"endtime": {
						"time": "1200",
						"timeSection": 0
					}
				},
				"offPeakPowerFlag": 0
			},
			"reserveChargeInfo2": {
				"reservChargeInfoDetail": {
					"reservInfo": {
						"day": [
							9
						],
						"time": {
							"time": "1200",
							"timeSection": 0
						}
					},
					"reservChargeSet": false,
					"reservFatcSet": {
						"defrost": false,
						"airTemp": {
							"value": "00H",
							"unit": 0
						},
						"airCtrl": 0,
						"heating1": 0
					}
				}
			},
			"reservFlag": 0,
			"ect": {
				"start": {
					"day": 9,
					"time": {
						"time": "1200",
						"timeSection": 0
					}
				},
				"end": {
					"day": 9,
					"time": {
						"time": "1200",
						"timeSection": 0
					}
				}
			},
			"targetSOClist": [
				{
					"targetSOClevel": 0,
					"dte": {
						"rangeByFuel": {
							"evModeRange": {
								"value": 473,
								"unit": 1
							},
							"totalAvailableRange": {
								"value": 473,
								"unit": 1
							}
						},
						"type": 2
					},
					"plugType": 1
				}
			]
		}
	},
	"ign3": false,
	"hoodOpen": false,
	"transCond": true,
	"steerWheelHeat": 0,
	"sideBackWindowHeat": 0,
	"tirePressureLamp": {
		"tirePressureLampAll": 0,
		"tirePressureLampFL": 0,
		"tirePressureLampFR": 0,
		"tirePressureLampRL": 0,
		"tirePressureLampRR": 0
	},
	"battery": {
		"batSoc": 85,
		"batState": 0
	},
	"sleepModeCheck": true,
	"time": "20200721084418"
}

vehicle.update():
{
	airCtrlOn: false,
	engine: false,
	doorLock: true,
	doorOpen: { frontLeft: 0, frontRight: 0, backLeft: 0, backRight: 0 },
	trunkOpen: false,
	airTemp: { value: '10H', unit: 0, hvacTempType: 0 },
	defrost: false,
	acc: false,
	evStatus: {
		batteryCharge: false,
		batteryStatus: 79,
		batteryPlugin: 0,
		remainTime2: { etc1: [Object], etc2: [Object], etc3: [Object], atc: [Object] },
		drvDistance: [ [Object] ],
		reservChargeInfos: {
			reservChargeInfo: [Object],
			offpeakPowerInfo: [Object],
			reserveChargeInfo2: [Object],
			reservFlag: 0,
			ect: [Object],
			targetSOClist: [Array]
		}
	},
	ign3: true,
	hoodOpen: false,
	transCond: true,
	steerWheelHeat: 0,
	sideBackWindowHeat: 0,
	tirePressureLamp: {
		tirePressureLampAll: 0,
		tirePressureLampFL: 0,
		tirePressureLampFR: 0,
		tirePressureLampRL: 0,
		tirePressureLampRR: 0
	},
	battery: { batSoc: 90, batState: 0 },
	time: '20200719212255'
}

A/C on:
status : {
	"airCtrlOn": true,
	"engine": true,
	"doorLock": false,
	"doorOpen": {
		"frontLeft": 0,
		"frontRight": 0,
		"backLeft": 0,
		"backRight": 0hargeSet": false,
	},atus (on bluelink cache)
	"trunkOpen": false,ch vehicle)
	"airTemp": {irTemp": {
		"value": "10H",
		"unit": 0,"unit": 0
		"hvacTempType": 1
	},        "airCtrl": 0,
	"defrost": false,g1": 0
	"acc": true,
	"evStatus": {
		"batteryCharge": false,
		"batteryStatus": 72,
		"batteryPlugin": 0,
		"remainTime2": {
			"etc1": {: 9,
				"value": 72,
				"unit": 1": "1200",
			},    "timeSection": 0
			"etc2": {
				"value": 620,
				"unit": 1
			},  "day": 9,
			"etc3": {": {
				"value": 155,1200",
				"unit": 1Section": 0
			},  }
			"atc": {
				"value": 37,
				"unit": 1ist": [
			} {
		},    "targetSOClevel": 100,
		"drvDistance": [
			{     "rangeByFuel": {
				"rangeByFuel": {ge": {
					"evModeRange": {73,
						"value": 326,
						"unit": 1
					},  "totalAvailableRange": {
					"totalAvailableRange": {
						"value": 326,
						"unit": 1
					} },
				},  "type": 2
				"type": 2
			}   "plugType": 1
		],  }
		"reservChargeInfos": {
			"reservChargeInfo": {
				"reservChargeInfoDetail": {
					"reservInfo": {
						"day": [
							9at": 0,
						],dowHeat": 0,
						"time": { {
							"time": "1200",
							"timeSection": 0
						}sureLampFR": 0,
					},ssureLampRL": 0,
					"reservChargeSet": false,
					"reservFatcSet": {
						"defrost": false,
						"airTemp": {
							"value": "00H",
							"unit": 0
						},00721101303"
						"airCtrl": 0,
						"heating1": 0
					}wanna do? (Use arrow keys)
				}
			},
			"offpeakPowerInfo": {
				"offPeakPowerTime1": {
					"starttime": {che)
						"time": "1200",icle)
						"timeSection": 0
					},
					"endtime": {
						"time": "1200",
						"timeSection": 0
					}
				},
				"offPeakPowerFlag": 0
			},
			"reserveChargeInfo2": {
				"reservChargeInfoDetail": {
					"reservInfo": {
						"day": [
							9
						],
						"time": {
							"time": "1200",
							"timeSection": 0
						}
					},
					"reservChargeSet": false,
					"reservFatcSet": {
						"defrost": false,
						"airTemp": {
							"value": "00H",
							"unit": 0
						},
						"airCtrl": 0,
						"heating1": 0
					}
				}
			},
			"reservFlag": 0,
			"ect": {
				"start": {
					"day": 9,
					"time": {
						"time": "1200",
						"timeSection": 0
					}
				},
				"end": {
					"day": 9,
					"time": {
						"time": "1200",
						"timeSection": 0
					}
				}
			},
			"targetSOClist": [
				{
					"targetSOClevel": 100,
					"dte": {
						"rangeByFuel": {
							"evModeRange": {
								"value": 473,
								"unit": 1
							},
							"totalAvailableRange": {
								"value": 473,
								"unit": 1
							}
						},
						"type": 2
					},
					"plugType": 1
				}
			]
		}
	},
	"ign3": true,
	"hoodOpen": false,
	"steerWheelHeat": 0,
	"sideBackWindowHeat": 0,
	"tirePressureLamp": {
		"tirePressureLampAll": 0,
		"tirePressureLampFL": 0,
		"tirePressureLampFR": 0,
		"tirePressureLampRL": 0,
		"tirePressureLampRR": 0
	},
	"battery": {
		"batSoc": 85,
		"batState": 0
	},
	"time": "20200721101516"
}

{
	chassis: {
		hoodOpen: false,
		trunkOpen: false,
		locked: true,
		doors: {
			frontRight: false,
			frontLeft: false,
			backLeft: false,
			backRight: false
		},
		tirePressureWarningLamp: {
			rearLeft: false,
			frontLeft: false,
			frontRight: false,
			rearRight: false,
			all: false
		}
	},
	climate: {
		active: false,
		steeringwheelHeat: false,
		sideMirrorHeat: false,
		rearWindowHeat: false,
		defrost: false,
		temperatureSetpoint: 20,
		temperatureUnit: 0
	},
	engine: {
		ignition: false,
		adaptiveCruiseControl: false,
		range: 400,
		charging: false,
		EVbatteryCharge: 87,
		batteryCharge: 83
	}
}

{
	latitude: 52.068369,
	longitude: 5.104333,
	altitude: 0,
	speed: { unit: 0, value: 0 },
	heading: 234
}

{ value: 171, unit: 1 }

*/

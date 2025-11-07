const admin = require("firebase-admin");
const functions = require("firebase-functions");
admin.initializeApp();

const teamApi = require("./api/teams");

exports.createTeam = teamApi.createTeam;
exports.joinTeam = teamApi.joinTeam;
exports.getTeamDashboard = teamApi.getTeamDashboard;

const userApi = require("./api/users");
exports.registerDeviceToken = userApi.registerDeviceToken;

const missionApi = require("./api/missions");
exports.getTodayMission = missionApi.getTodayMission;

const notificationScheduler = require("./scheduled/notifications");
exports.sendWakeUpNotifications = notificationScheduler.sendWakeUpNotifications;
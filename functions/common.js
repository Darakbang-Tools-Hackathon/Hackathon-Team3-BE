const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onUserCreated, onUserDeleted} = require("firebase-functions/v2/auth");
const {logger} = require("firebase-functions");

initializeApp();

const db = getFirestore();

module.exports = {
  db,
  onCall,
  HttpsError,
  onUserCreated,
  onUserDeleted,
  logger,
};

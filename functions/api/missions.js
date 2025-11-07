const functions = require("firebase-functions");

/**
 * @param {object} data - (empty)
 * @param {object} context
 * @return {Promise<object>} - { missionId: string }
 */
exports.getTodayMission = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "unauthenticated",
        "로그인이 필요한 기능입니다.",
    );
  }

  return {
    missionId: "warrior_2",
  };
});

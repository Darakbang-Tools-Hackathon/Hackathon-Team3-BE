const functions = require("firebase-functions");
const admin = require("firebase-admin");
const db = admin.firestore();

/**
 * FCM 기기 토큰 등록

 * @param {object} data - { token: string }
 * @param {object} context
 * @return {Promise<object>} - { status: "success" }
 */
exports.registerDeviceToken = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "unauthenticated",
        "로그인이 필요한 기능입니다.",
    );
  }

  const token = data.token;
  if (!token) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "FCM 토큰이 없습니다.",
    );
  }

  try {
    const userId = context.auth.uid;
    // /users/{userId}에 fcmToken 필드를 update
    await db.collection("users").doc(userId).update({
      fcmToken: token,
    });

    return {status: "success", message: "FCM 토큰이 등록되었습니다."};
  } catch (error) {
    console.error("FCM 토큰 등록 중 에러:", error);
    throw new functions.https.HttpsError(
        "internal",
        "FCM 토큰 등록에 실패했습니다.",
    );
  }
});

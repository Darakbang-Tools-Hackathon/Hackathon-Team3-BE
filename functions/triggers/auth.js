const {db, onUserCreated, onUserDeleted, logger} = require("../common");

// 신규 유저
exports.createUserDocument = onUserCreated(async (event) => {
  const user = event.data;
  const userRef = db.collection("users").doc(user.uid);

  logger.log(`Creating user document for: ${user.uid}, email: ${user.email}`);

  try {
    await userRef.set({
      email: user.email || null,
      displayName: user.displayName || "신규 유저",
      userLP: 0,
      wakeUpTime: null,
      teamId: null,
      lastChallengeStatus: "pending",
      weeklySuccessCount: 0,
      fcmToken: null,
    });
    logger.log(`Successfully created user document for: ${user.uid}`);
    return;
  } catch (error) {
    logger.error(`Error creating user document for ${user.uid}:`, error);
    return;
  }
});

// 유저 탈퇴
exports.deleteUserDocument = onUserDeleted(async (event) => {
  const user = event.data;
  const userRef = db.collection("users").doc(user.uid);

  logger.log(`Deleting user document for: ${user.uid}`);

  try {
    await userRef.delete();
    logger.log(`Successfully deleted user document for: ${user.uid}`);
    return;
  } catch (error) {
    logger.error(`Error deleting user document for ${user.uid}:`, error);
    return;
  }
});

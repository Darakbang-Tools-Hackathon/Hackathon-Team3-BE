const {db, onCall, HttpsError, logger} = require("../common");

const {getFirestore} = require("firebase-admin/firestore");


exports.getTodayMission = onCall(async (request) => {
  if (!request.auth) {
    logger.warn("getTodayMission: Unauthenticated user.");
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }

  const missionRef = db.collection("config").doc("todayMission");

  try {
    const doc = await missionRef.get();
    if (!doc.exists) {
      logger.error("getTodayMission: 'todayMission' document does not exist!");
      throw new HttpsError("not-found", "오늘의 미션 정보를 찾을 수 없습니다.");
    }

    // todayMission 반환
    logger.log("Fetched todayMission:", doc.data());
    return doc.data();
  } catch (error) {
    logger.error("Error fetching todayMission:", error);
    throw new HttpsError("internal", "미션 정보 로딩 중 오류가 발생했습니다.");
  }
});

exports.processChallengeResult = onCall(async (request) => {
  if (!request.auth) {
    logger.warn("processChallengeResult: Unauthenticated user.");
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }

  const userId = request.auth.uid;
  const result = request.data.result;

  if (result !== "success" && result !== "fail") {
    logger.warn(`processChallengeResult: Invalid result value`);
    throw new HttpsError("invalid-argument", "결과값이 유효하지 않습니다.");
  }

  // 오늘 날짜 (KST 기준)
  const today = new Date();
  today.setHours(today.getHours() + 9);
  const dateStr = today.toISOString().split("T")[0];

  const userRef = db.collection("users").doc(userId);
  const challengeId = `${dateStr}_${userId}`;
  const challengeRef = db.collection("challenges").doc(challengeId);

  try {
    await getFirestore().runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error("User document not found!");
      }

      const userData = userDoc.data();
      const teamId = userData.teamId;

      // 챌린지 이력
      transaction.set(challengeRef, {
        userId: userId,
        date: dateStr,
        status: result,
      });

      // 유저정보 업데이트
      const lpChange = result === "success" ? 100 : -10;
      const successCountChange = result === "success" ? 1 : 0;

      transaction.update(userRef, {
        userLP: userData.userLP + lpChange,
        lastChallengeStatus: result,
        weeklySuccessCount: userData.weeklySuccessCount + successCountChange,
      });

      // 팀 정보 업데이트
      if (teamId && result === "success") {
        const teamRef = db.collection("teams").doc(teamId);

        // members: 'userId'의 'weeklySuccessCount' 값 업데이트
        const teamUpdateField = `members.${userId}.weeklySuccessCount`;
        const teamDoc = await transaction.get(teamRef);

        const teamData = teamDoc.data();
        const memberExists = teamDoc.exists &&
                             teamData &&
                             teamData.members &&
                             teamData.members[userId];

        if (memberExists) {
          const count = teamData.members[userId].weeklySuccessCount;
          const currentTeamSuccessCount = count || 0;

          transaction.update(teamRef, {
            [teamUpdateField]: currentTeamSuccessCount + 1,
          });
        }
      }
    });

    logger.log(`Success: challenge result '${result}' for user ${userId}`);
    return {success: true, result: result};
  } catch (error) {
    logger.error(`Error: challenge result for user ${userId}:`, error);
    throw new HttpsError("internal", "챌린지 결과 처리 중 오류가 발생했습니다.");
  }
});

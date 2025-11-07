const admin = require("firebase-admin");
const functions = require("firebase-functions");

admin.initializeApp();

const db = admin.firestore();


// Create Team
function generateJoinCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

exports.createTeam = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "로그인이 필요한 기능입니다.",
    );
  }

  const teamName = data.teamName;
  if (!teamName || typeof teamName !== "string" || teamName.length < 2) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "팀 이름은 2글자 이상이어야 합니다.",
    );
  }

  try {
    const userId = context.auth.uid;
    const displayName = context.auth.token.name || "user";
    const joinCode = generateJoinCode();

    const newTeam = {
      teamName: teamName,
      teamLP: 0,
      joinCode: joinCode,
      members: {
        [userId]: {
          displayName: displayName,
          totalSuccess: 0,
        },
      },
    };

    // add new team
    const teamRef = await db.collection("teams").add(newTeam);

    // teamID update
    await db.collection("users").doc(userId).update({
      teamId: teamRef.id,
    });

    return {
      status: "success",
      teamId: teamRef.id,
      joinCode: joinCode,
    };
  } catch (error) {
    console.error("팀 생성 중 오류:", error);
    throw new functions.https.HttpsError(
      "internal",
      "팀 생성에 실패했습니다.",
    );
  }
});

// Join Team
exports.joinTeam = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "로그인이 필요한 기능입니다.",
    );
  }

  const joinCode = data.joinCode;
  if (!joinCode || typeof joinCode !== "string") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "참여 코드가 올바르지 않습니다.",
    );
  }

  const userId = context.auth.uid;
  const displayName = context.auth.token.name || "user";

  try {
    await db.runTransaction(async (transaction) => {
      // 팀 코드 입력
      const teamsRef = db.collection("teams");
      const teamQuery = await transaction.get(
        teamsRef.where("joinCode", "==", joinCode.toUpperCase()),
      );

      if (teamQuery.empty) {
        throw new functions.https.HttpsError(
          "not-found",
          "존재하지 않는 참여 코드입니다.",
        );
      }

      // 팀 정보
      const teamDoc = teamQuery.docs[0];
      const teamId = teamDoc.id;

      // /teams/{teamId} 팀의 members에 user 추가
      const memberUpdateKey = `members.${userId}`;
      transaction.update(teamDoc.ref, {
        [memberUpdateKey]: {
          displayName: displayName,
          totalSuccess: 0,
        },
      });

      // /users/{userId}에 내 teamId update
      const userRef = db.collection("users").doc(userId);
      transaction.update(userRef, {
        teamId: teamId,
      });
    });

    return { status: "success", message: "팀에 성공적으로 참가했습니다." };
  } catch (error) {
    console.error("팀 참가 중 에러:", error);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throw new functions.https.HttpsError("internal", "팀 참가에 실패했습니다。");
  }
});
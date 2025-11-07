const {db, onCall, HttpsError, logger} = require("../common");

/**
 * 4자리 랜덤 참여 코드를 생성합니다.
 * @return {string} 4자리 랜덤 코드
 */
function generateJoinCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

/**
 * Create Team
 */
exports.createTeam = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
        "unauthenticated",
        "로그인이 필요한 기능입니다.",
    );
  }

  const teamName = request.data.teamName;
  if (!teamName || typeof teamName !== "string" || teamName.length < 2) {
    throw new HttpsError(
        "invalid-argument",
        "팀 이름은 2글자 이상이어야 합니다.",
    );
  }

  const userId = request.auth.uid;

  try {
    const displayName = request.auth.token.name || "user";
    const joinCode = generateJoinCode();

    const newTeam = {
      teamName: teamName,
      teamLP: 0,
      joinCode: joinCode,
      members: {
        [userId]: {
          displayName: displayName,
          weeklySuccessCount: 0,
        },
      },
    };

    // add new team
    const teamRef = await db.collection("teams").add(newTeam);

    // teamID update
    await db.collection("users").doc(userId).update({
      teamId: teamRef.id,
    });

    logger.log(`Team created: ${teamRef.id} by user ${userId}`);
    return {
      status: "success",
      teamId: teamRef.id,
      joinCode: joinCode,
    };
  } catch (error) {
    logger.error(`Error creating team for user ${userId}:`, error);
    throw new HttpsError(
        "internal",
        "팀 생성에 실패했습니다.",
    );
  }
});

/**
 * Join Team
 */
exports.joinTeam = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
        "unauthenticated",
        "로그인이 필요한 기능입니다.",
    );
  }

  const joinCode = request.data.joinCode;
  if (!joinCode || typeof joinCode !== "string") {
    throw new HttpsError(
        "invalid-argument",
        "참여 코드가 올바르지 않습니다.",
    );
  }

  const userId = request.auth.uid;
  const displayName = request.auth.token.name || "user";

  try {
    await db.runTransaction(async (transaction) => {
      // 팀 코드 입력
      const teamsRef = db.collection("teams");
      const teamQuery = await transaction.get(
          teamsRef.where("joinCode", "==", joinCode.toUpperCase()),
      );

      if (teamQuery.empty) {
        throw new HttpsError(
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
          weeklySuccessCount: 0,
        },
      });

      // /users/{userId}에 내 teamId update
      const userRef = db.collection("users").doc(userId);
      transaction.update(userRef, {
        teamId: teamId,
      });
    });

    logger.log(`User ${userId} joined team with code ${joinCode}`);
    return {status: "success", message: "팀에 성공적으로 참가했습니다."};
  } catch (error) {
    logger.error(`Error joining team for user ${userId}:`, error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", "팀 참가에 실패했습니다.");
  }
});

/**
 * Team Dashboard 조회
 */
exports.getTeamDashboard = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
        "unauthenticated",
        "로그인이 필요한 기능입니다.",
    );
  }

  const teamId = request.data.teamId;
  if (!teamId || typeof teamId !== "string") {
    throw new HttpsError(
        "invalid-argument",
        "팀 ID가 올바르지 않습니다.",
    );
  }

  const userId = request.auth.uid;

  try {
    const teamDoc = await db.collection("teams").doc(teamId).get();

    if (!teamDoc.exists) {
      throw new HttpsError(
          "not-found",
          "팀을 찾을 수 없습니다.",
      );
    }

    const teamData = teamDoc.data();

    if (!teamData.members || !teamData.members[userId]) {
      throw new HttpsError(
          "permission-denied",
          "이 팀의 멤버가 아닙니다.",
      );
    }

    const membersArray = Object.keys(teamData.members).map((id) => {
      return {
        userId: id,
        displayName: teamData.members[id].displayName,
        weeklySuccessCount: teamData.members[id].weeklySuccessCount || 0,
      };
    });

    // weeklySuccessCount 기준 랭킹
    membersArray.sort((a, b) => b.weeklySuccessCount - a.weeklySuccessCount);

    logger.log(`Fetched dashboard for team ${teamId}`);
    return {
      status: "success",
      teamInfo: {
        teamName: teamData.teamName,
        teamLP: teamData.teamLP,
        joinCode: teamData.joinCode,
      },
      ranking: membersArray,
    };
  } catch (error) {
    logger.error(`Error fetching dashboard for team ${teamId}:`, error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError(
        "internal",
        "대시보드 조회에 실패했습니다.",
    );
  }
});

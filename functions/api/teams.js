const {db, onCall, HttpsError, logger} = require("../common");
const {getFirestore} = require("firebase-admin/firestore");
const admin = require("firebase-admin");

// --- 유틸리티 함수 ---

/**
 * @return {string} 4자리 랜덤 코드 생성
 */
function generateJoinCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// --- 1. 팀 생성 (POST /teams) ---
exports.createTeam = onCall(async (data, context) => {
  if (!context.auth) {
    throw new HttpsError("unauthenticated", "로그인이 필요한 기능입니다.");
  }

  const {teamName, accessType = "public"} = data;
  if (!teamName || typeof teamName !== "string" || teamName.length < 2) {
    throw new HttpsError("invalid-argument", "팀 이름은 2글자 이상이어야 합니다.");
  }
  if (!["public", "private"].includes(accessType)) {
    throw new HttpsError(
        "invalid-argument",
        "accessType은 'public' 또는 'private'이어야 합니다.",
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
      accessType: accessType,
      leaderId: userId,
      members: {
        [userId]: {
          displayName: displayName,
          weeklySuccessCount: 0,
        },
      },
      pendingMembers: accessType === "private" ? {} : null,
    };

    const teamRef = await db.collection("teams").add(newTeam);
    const teamId = teamRef.id;

    // ★다중 팀 멤버십 및 팀장 처리: /users/{userId}에 teamIds 및 leaderOf 배열 업데이트
    await db.collection("users").doc(userId).update({
      teamIds: admin.firestore.FieldValue.arrayUnion(teamId), // 멤버십 추가
      leaderOf: admin.firestore.FieldValue.arrayUnion(teamId), // 팀장 목록에 추가
    });

    return {
      status: "success",
      teamId: teamId,
      joinCode: joinCode,
    };
  } catch (error) {
    logger.error("팀 생성 중 오류:", error);
    throw new HttpsError("internal", "팀 생성에 실패했습니다.");
  }
});


// --- 2. 팀 참여/신청 (POST /teams/join) ---
exports.joinTeam = onCall(async (data, context) => {
  if (!context.auth) {
    throw new HttpsError("unauthenticated", "로그인이 필요한 기능입니다.");
  }

  const joinCode = data.joinCode;
  if (!joinCode || typeof joinCode !== "string") {
    throw new HttpsError("invalid-argument", "참여 코드가 올바르지 않습니다.");
  }

  const userId = context.auth.uid;
  const displayName = context.auth.token.name || "user";
  const teamsRef = db.collection("teams");

  try {
    await getFirestore().runTransaction(async (transaction) => {
      // 1. 팀 코드 검색 및 확인
      const teamQuery = await transaction.get(
          teamsRef.where("joinCode", "==", joinCode.toUpperCase()),
      );

      if (teamQuery.empty) {
        throw new HttpsError("not-found", "존재하지 않는 참여 코드입니다.");
      }

      const teamDoc = teamQuery.docs[0];
      const teamId = teamDoc.id;
      const teamData = teamDoc.data();
      const userRef = db.collection("users").doc(userId);
      const userDoc = await transaction.get(userRef);
      const userData = userDoc.data();
      const currentTeamIds = userData.teamIds || [];

      // 2. 이미 팀에 속해 있는지 확인 (다중 팀 멤버십)
      if (currentTeamIds.includes(teamId)) {
        throw new HttpsError("failed-precondition", "이미 이 팀의 멤버입니다.");
      }

      // 3. Public vs Private 로직 분기
      if (teamData.accessType === "public") {
        // Public 팀: 바로 멤버로 추가
        const memberUpdateKey = `members.${userId}`;
        transaction.update(teamDoc.ref, {
          [memberUpdateKey]: {
            displayName: displayName,
            weeklySuccessCount: 0,
          },
        });
        // 유저 문서 업데이트: teamIds 배열에 추가
        transaction.update(userRef, {
          teamIds: admin.firestore.FieldValue.arrayUnion(teamId),
        });
        return {status: "success", message: "팀에 성공적으로 참가했습니다."};
      } else {
        // Private 팀: 가입 요청 목록에 추가
        if (teamData.pendingMembers && teamData.pendingMembers[userId]) {
          throw new HttpsError("already-exists", "이미 가입 요청을 보냈습니다.");
        }

        const pendingMemberUpdateKey = `pendingMembers.${userId}`;
        transaction.update(teamDoc.ref, {
          [pendingMemberUpdateKey]: {
            displayName: displayName,
            requestedAt: new Date().toISOString(),
          },
        });
        return {status: "pending", message: "팀장 승인을 기다리는 중입니다."};
      }
    });

    return {status: "success", message: "처리 완료"};
  } catch (error) {
    logger.error("팀 참가 중 에러:", error);
    if (error.code) {
      throw error;
    }
    throw new HttpsError("internal", "팀 참가에 실패했습니다.");
  }
});


// --- 3. 팀원 강퇴 (팀장 권한) ---
exports.kickMember = onCall(async (data, context) => {
  if (!context.auth) {
    throw new HttpsError("unauthenticated", "로그인이 필요한 기능입니다.");
  }

  const leaderId = context.auth.uid;
  const {teamId, memberIdToKick} = data;

  if (!teamId || !memberIdToKick) {
    throw new HttpsError("invalid-argument", "팀 ID 또는 강퇴할 멤버 ID가 필요합니다.");
  }

  if (leaderId === memberIdToKick) {
    throw new HttpsError(
        "failed-precondition",
        "팀장은 자신을 강퇴할 수 없습니다. 팀 탈퇴 기능을 사용하세요.",
    );
  }

  try {
    await getFirestore().runTransaction(async (transaction) => {
      const teamRef = db.collection("teams").doc(teamId);
      const userRef = db.collection("users").doc(memberIdToKick);
      const teamDoc = await transaction.get(teamRef);
      const userDoc = await transaction.get(userRef);

      if (!teamDoc.exists) {
        throw new HttpsError(
            "not-found",
            "팀이 존재하지 않습니다.",
        );
      }

      if (!userDoc.exists) {
        throw new HttpsError(
            "not-found",
            "강퇴할 유저를 찾을 수 없습니다.",
        );
      }

      const teamData = teamDoc.data();
      const userData = userDoc.data();

      // 1. 팀장 권한 확인
      if (teamData.leaderId !== leaderId) {
        throw new HttpsError("permission-denied", "팀장만 팀원을 강퇴할 수 있습니다.");
      }

      // 2. 멤버가 팀에 속해 있는지 확인
      if (!teamData.members || !teamData.members[memberIdToKick]) {
        throw new HttpsError("not-found", "해당 멤버는 팀에 속해 있지 않습니다.");
      }

      // 3. /teams 문서에서 멤버 삭제
      const newMembers = {...teamData.members};
      delete newMembers[memberIdToKick];

      transaction.update(teamRef, {
        members: newMembers,
      });

      // 4. 강퇴된 유저의 /users/{memberIdToKick} 문서에서 teamIds 및 leaderOf 초기화
      const memberIsLeader = (userData.leaderOf || []).includes(teamId);

      const userUpdateData = {
        teamIds: admin.firestore.FieldValue.arrayRemove(teamId), // 멤버십 제거
      };
      if (memberIsLeader) {
        userUpdateData.leaderOf =
          admin.firestore.FieldValue.arrayRemove(teamId);
      }


      transaction.update(userRef, userUpdateData);
    });

    return {status: "success", message: "팀원을 성공적으로 강퇴했습니다."};
  } catch (error) {
    logger.error("팀원 강퇴 중 오류:", error);
    if (error.code) {
      throw error;
    }
    throw new HttpsError("internal", "팀원 강퇴에 실패했습니다.");
  }
});


// --- 4. 팀장 위임 (팀장 권한) ---
exports.delegateLeader = onCall(async (data, context) => {
  if (!context.auth) {
    throw new HttpsError("unauthenticated", "로그인이 필요한 기능입니다.");
  }

  const currentLeaderId = context.auth.uid;
  const {teamId, newLeaderId} = data;

  if (!teamId || !newLeaderId) {
    throw new HttpsError("invalid-argument", "팀 ID와 새 팀장 ID가 필요합니다.");
  }
  if (currentLeaderId === newLeaderId) {
    throw new HttpsError("failed-precondition", "자기 자신에게 위임할 수 없습니다.");
  }

  try {
    await getFirestore().runTransaction(async (transaction) => {
      const teamRef = db.collection("teams").doc(teamId);
      const newLeaderUserRef = db.collection("users").doc(newLeaderId);
      const currentLeaderUserRef = db.collection("users").doc(currentLeaderId);

      const teamDoc = await transaction.get(teamRef);
      const newLeaderUserDoc = await transaction.get(newLeaderUserRef);

      if (!teamDoc.exists) {
        throw new HttpsError(
            "not-found",
            "팀이 존재하지 않습니다.",
        );
      }

      if (!newLeaderUserDoc.exists) {
        throw new HttpsError(
            "not-found",
            "새 팀장을 찾을 수 없습니다.",
        );
      }


      const teamData = teamDoc.data();

      // 1. 현재 유저가 팀장인지 확인
      if (teamData.leaderId !== currentLeaderId) {
        throw new HttpsError("permission-denied", "현재 팀장만 권한을 위임할 수 있습니다.");
      }

      // 2. 새 리더가 팀 멤버인지 확인
      if (!teamData.members || !teamData.members[newLeaderId]) {
        throw new HttpsError("not-found", "위임할 멤버가 팀에 속해 있지 않습니다.");
      }

      // 3. team 문서의 leaderId 필드 업데이트
      transaction.update(teamRef, {
        leaderId: newLeaderId,
      });

      // 4. (다중 팀장 처리) 현재 팀장의 leaderOf 배열에서 팀 ID 제거
      transaction.update(currentLeaderUserRef, {
        leaderOf: admin.firestore.FieldValue.arrayRemove(teamId),
      });

      // 5. (다중 팀장 처리) 새 팀장의 leaderOf 배열에 팀 ID 추가
      transaction.update(newLeaderUserRef, {
        leaderOf: admin.firestore.FieldValue.arrayUnion(teamId),
      });
    });

    return {status: "success", message: "팀장 권한을 성공적으로 위임했습니다."};
  } catch (error) {
    logger.error("팀장 위임 중 오류:", error);
    if (error.code) {
      throw error;
    }
    throw new HttpsError("internal", "팀장 위임에 실패했습니다.");
  }
});


// --- 5. 팀 탈퇴 (멤버도 리더도 모두 사용 가능) ---
exports.leaveTeam = onCall(async (data, context) => {
  if (!context.auth) {
    throw new HttpsError("unauthenticated", "로그인이 필요한 기능입니다.");
  }

  const userId = context.auth.uid;
  const {teamId} = data;
  const userRef = db.collection("users").doc(userId);

  if (!teamId) {
    // teamId가 없으면 유저 문서에서만 teamIds와 leaderOf를 정리하고 종료
    await userRef.update({
      teamIds: admin.firestore.FieldValue.arrayRemove(null),
      leaderOf: admin.firestore.FieldValue.arrayRemove(null),
    });
    return {status: "success", message: "유저 문서 정리 완료."};
  }

  try {
    await getFirestore().runTransaction(async (transaction) => {
      const teamRef = db.collection("teams").doc(teamId);
      const teamDoc = await transaction.get(teamRef);

      if (!teamDoc.exists) {
        // 팀이 삭제되었을 경우, 유저 문서에서만 팀 ID 정리
        transaction.update(userRef, {
          teamIds: admin.firestore.FieldValue.arrayRemove(teamId),
          leaderOf: admin.firestore.FieldValue.arrayRemove(teamId),
        });
        return;
      }
      const teamData = teamDoc.data();
      const isLeaderOfThisTeam = teamData.leaderId === userId;

      // 1. 멤버 목록에서 삭제
      if (teamData.members && teamData.members[userId]) {
        const newMembers = {...teamData.members};
        delete newMembers[userId];

        transaction.update(teamRef, {
          members: newMembers,
        });

        // 2. 팀장이 탈퇴할 경우 (다른 멤버에게 위임하거나 팀 삭제)
        if (isLeaderOfThisTeam) {
          const remainingMembers = Object.keys(newMembers);
          if (remainingMembers.length > 0) {
            // 남은 멤버가 있으면 첫 번째 멤버에게 위임
            transaction.update(teamRef, {leaderId: remainingMembers[0]});
          } else {
            // 남은 멤버가 없으면 팀 삭제
            transaction.delete(teamRef);
          }
        }
      }

      // 3. 유저 문서에서 teamIds 및 leaderOf 정리
      transaction.update(userRef, {
        teamIds: admin.firestore.FieldValue.arrayRemove(teamId),
        leaderOf: admin.firestore.FieldValue.arrayRemove(teamId),
      });
    });

    return {status: "success", message: "팀에서 성공적으로 탈퇴했습니다."};
  } catch (error) {
    logger.error("팀 탈퇴 중 오류:", error);
    if (error.code) {
      throw error;
    }
    throw new HttpsError("internal", "팀 탈퇴에 실패했습니다.");
  }
});


// --- 6. (신규) 가입 요청 승인 (팀장 권한) ---
exports.acceptJoinRequest = onCall(async (data, context) => {
  if (!context.auth) {
    throw new HttpsError("unauthenticated", "로그인이 필요한 기능입니다.");
  }

  const leaderId = context.auth.uid;
  const {teamId, pendingMemberId} = data;

  if (!teamId || !pendingMemberId) {
    throw new HttpsError("invalid-argument", "팀 ID와 승인할 멤버 ID가 필요합니다.");
  }

  try {
    await getFirestore().runTransaction(async (transaction) => {
      const teamRef = db.collection("teams").doc(teamId);
      const userRef = db.collection("users").doc(pendingMemberId);
      const teamDoc = await transaction.get(teamRef);
      const userDoc = await transaction.get(userRef);

      if (!teamDoc.exists) {
        throw new HttpsError("not-found", "팀이 존재하지 않습니다.");
      }
      if (!userDoc.exists) {
        throw new HttpsError("not-found", "유저를 찾을 수 없습니다.");
      }

      const teamData = teamDoc.data();
      const userData = userDoc.data();

      // 1. 팀장 권한 확인
      if (teamData.leaderId !== leaderId) {
        throw new HttpsError("permission-denied", "팀장만 가입 요청을 승인할 수 있습니다.");
      }

      // 2. 요청이 대기 중인지 확인
      if (!teamData.pendingMembers ||
        !teamData.pendingMembers[pendingMemberId]) {
        throw new HttpsError("failed-precondition", "대기 중인 요청이 없습니다.");
      }

      // 3. 유저가 이미 이 팀에 속해있는지 확인 (다중 멤버십)
      if ((userData.teamIds || []).includes(teamId)) {
        throw new HttpsError("already-exists", "유저가 이미 팀 멤버입니다.");
      }

      // 4. /teams 문서에서 처리: 멤버에 추가하고, pendingMembers에서 삭제
      const memberUpdateKey = `members.${pendingMemberId}`;
      const pendingRemoveKey = `pendingMembers.${pendingMemberId}`;

      transaction.update(teamDoc.ref, {
        [memberUpdateKey]: {
          displayName: userData.displayName || "user",
          weeklySuccessCount: 0,
        },
        [pendingRemoveKey]: admin.firestore.FieldValue.delete(),
      });

      // 5. 유저 문서 업데이트: teamIds 배열에 팀 ID 추가
      transaction.update(userRef, {
        teamIds: admin.firestore.FieldValue.arrayUnion(teamId),
      });
    });

    return {status: "success", message: "가입 요청을 성공적으로 승인했습니다."};
  } catch (error) {
    logger.error("가입 승인 중 오류:", error);
    if (error.code) {
      throw error;
    }
    throw new HttpsError("internal", "가입 승인에 실패했습니다.");
  }
});


// --- 7. (신규) 가입 요청 거절 (팀장 권한) ---
exports.rejectJoinRequest = onCall(async (data, context) => {
  if (!context.auth) {
    throw new HttpsError("unauthenticated", "로그인이 필요한 기능입니다.");
  }

  const leaderId = context.auth.uid;
  const {teamId, pendingMemberId} = data;

  if (!teamId || !pendingMemberId) {
    throw new HttpsError("invalid-argument", "팀 ID와 거절할 멤버 ID가 필요합니다.");
  }

  try {
    const teamRef = db.collection("teams").doc(teamId);
    const teamDoc = await teamRef.get();

    if (!teamDoc.exists) {
      throw new HttpsError("not-found", "팀이 존재하지 않습니다.");
    }
    const teamData = teamDoc.data();

    // 1. 팀장 권한 확인
    if (teamData.leaderId !== leaderId) {
      throw new HttpsError("permission-denied", "팀장만 요청을 거절할 수 있습니다.");
    }

    // 2. 요청이 대기 중인지 확인
    if (!teamData.pendingMembers || !teamData.pendingMembers[pendingMemberId]) {
      throw new HttpsError("failed-precondition", "대기 중인 요청이 없습니다.");
    }

    // 3. /teams 문서에서 pendingMembers 필드만 삭제
    const pendingRemoveKey = `pendingMembers.${pendingMemberId}`;
    await teamRef.update({
      [pendingRemoveKey]: admin.firestore.FieldValue.delete(),
    });

    return {status: "success", message: "가입 요청을 성공적으로 거절했습니다."};
  } catch (error) {
    logger.error("가입 거절 중 오류:", error);
    if (error.code) {
      throw error;
    }
    throw new HttpsError("internal", "가입 거절에 실패했습니다.");
  }
});


// --- 8. (신규) 가입 요청 목록 조회 (팀장 권한) ---
exports.getPendingRequests = onCall(async (data, context) => {
  if (!context.auth) {
    throw new HttpsError("unauthenticated", "로그인이 필요한 기능입니다.");
  }

  const leaderId = context.auth.uid;
  const {teamId} = data;

  if (!teamId) {
    throw new HttpsError("invalid-argument", "팀 ID가 필요합니다.");
  }

  try {
    const teamRef = db.collection("teams").doc(teamId);
    const teamDoc = await teamRef.get();

    if (!teamDoc.exists) {
      throw new HttpsError("not-found", "팀이 존재하지 않습니다.");
    }
    const teamData = teamDoc.data();

    // 1. 팀장 권한 확인
    if (teamData.leaderId !== leaderId) {
      throw new HttpsError("permission-denied", "팀장만 요청 목록을 조회할 수 있습니다.");
    }

    // 2. 요청 목록 반환 (pendingMembers 맵을 배열로 변환하여 반환)
    const pendingMembers = teamData.pendingMembers || {};

    const requests = Object.keys(pendingMembers).map((userId) => ({
      userId: userId,
      displayName: pendingMembers[userId].displayName,
      requestedAt: pendingMembers[userId].requestedAt,
    }));

    return {status: "success", requests: requests};
  } catch (error) {
    logger.error("가입 요청 목록 조회 중 오류:", error);
    if (error.code) {
      throw error;
    }
    throw new HttpsError("internal", "요청 목록 조회에 실패했습니다.");
  }
});

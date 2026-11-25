import { AppError, missing, forbidden, invalidState } from './errors.js';
export function createApplicationService(repo) {
  // Transaction helper
  function transaction(callback) {
    repo.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      repo.db.exec('COMMIT');
      return result;
    } catch (error) {
      repo.db.exec('ROLLBACK');
      throw error;
    }
  }
  // Manager permission
  function checkManager(actor, event) {
    if (actor.role !== 'MANAGER' || actor.id !== event.managerId) {
      throw forbidden();
    }
  }
  // Student permission
  function checkStudent(actor) {
    if (actor.role !== 'STUDENT') {
      throw forbidden();
    }
  }
  return {
      // TODO-01: 행사·학생 역할·중복 검사 → PENDING 저장 + APPLY 이력.
      // 취소·승인 취소 기록도 중복입니다. 반환: 신청 객체.
    apply(actor, eventId) {
      const event = repo.event(eventId);
      if (!event) {
        throw missing('행사');
      }
      checkStudent(actor);
      const existing = repo.existing(eventId, actor.id);
      if (existing) {
        throw new AppError( 409, 'ALREADY_APPLIED', '이미 신청한 행사입니다.');
      }
      try {
        return transaction(() => {
          const application = repo.insert(eventId, actor.id);
          repo.addHistory({
            applicationId: application.id,
            actorId: actor.id,
            action: 'APPLY',
            fromStatus: null,
            toStatus: 'PENDING'
          });
          return application;
        });
      } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          throw new AppError( 409, 'ALREADY_APPLIED', '이미 신청한 행사입니다.' );
        }
        throw error;
      }
    },
      // TODO-02: 본인의 PENDING만 CANCELLED로 변경 + CANCEL 이력.
      // 학생의 대기 취소는 승인 자리를 비우지 않으므로 자동 승급하지 않습니다.
    cancel(actor, applicationId) {
      const application = repo.application(applicationId);
      if (!application) {
        throw missing('신청');
      }
      if ( actor.role !== 'STUDENT' || actor.id !== application.userId ) {
        throw forbidden();
      }
      if (application.status !== 'PENDING') {
        throw invalidState();
      }
      return transaction(() => {
        const cancelled = repo.setStatus( applicationId, 'CANCELLED');
        repo.addHistory({
          applicationId: applicationId,
          actorId: actor.id,
          action: 'CANCEL',
          fromStatus: 'PENDING',
          toStatus: 'CANCELLED'
        });
        return cancelled;
      });
    },
      // TODO-03: 담당자·PENDING·정원 검사 → APPROVED + APPROVE 이력.
      // 직접 승인은 운영자가 선택합니다. FIFO는 승인 취소 때의 자동 승급에 적용합니다.
    approve(actor, applicationId) {
      const application = repo.application(applicationId);
      if (!application) {
        throw missing('신청');
      }
      const event = repo.event(application.eventId);
      checkManager(actor, event);
      if (application.status !== 'PENDING') {
        throw invalidState();
      }
      if (repo.approvedCount(application.eventId) >= event.capacity) {
        throw new AppError( 409, 'CAPACITY_FULL', '행사 정원이 가득 찼습니다.');
      }
      return transaction(() => {
        const approved = repo.setStatus( applicationId, 'APPROVED' );
        repo.addHistory({
          applicationId: applicationId,
          actorId: actor.id,
          action: 'APPROVE',
          fromStatus: 'PENDING',
          toStatus: 'APPROVED'
        });
        return approved;
      });
    },
      // TODO-04: 담당자·APPROVED 검사 → REVOKED + REVOKE 이력.
      // 같은 행사 PENDING 중 created_at ASC, id ASC 첫 1건을 자동 승인합니다.
      // AUTO_APPROVE 이력의 causeHistoryId는 이 요청의 REVOKE 이력 ID입니다.
      // 상태와 이력의 부분 저장을 막고, 거부·오류 시 전체를 되돌리세요.
      // 반환: {revoked: 신청 객체, promoted: 신청 객체 또는 null}.
    revoke(actor, applicationId, reason) {
      const trimmedReason =
        typeof reason === 'string' ? reason.trim() : '';
      if ( trimmedReason.length < 5 || trimmedReason.length > 200 ) {
        throw new AppError( 400, 'BAD_INPUT', '취소 사유는 5~200자여야 합니다.');
      }
      const application = repo.application(applicationId);
      if (!application) {
        throw missing('신청');
      }
      const event = repo.event(application.eventId);
      checkManager(actor, event);
      if (application.status !== 'APPROVED') {
        throw invalidState();
      }
      return transaction(() => {
        // 1. 승인 취소
        const revoked = repo.setStatus( applicationId, 'REVOKED');

        // 2. REVOKE 이력 저장
        const revokeHistoryId = repo.addHistory({
          applicationId: applicationId,
          actorId: actor.id,
          action: 'REVOKE',
          fromStatus: 'APPROVED',
          toStatus: 'REVOKED',
          reason: trimmedReason
        });

        // 3. FIFO 대기자 검색
        const nextApplicant = repo.db.prepare(`
          SELECT id
          FROM applications
          WHERE event_id = ?
            AND status = 'PENDING'
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get(application.eventId);
        let promoted = null;

        // 4. 대기자가 있으면 자동 승인
        if (nextApplicant) {
          promoted = repo.setStatus( nextApplicant.id, 'APPROVED' );

          // 5. AUTO_APPROVE 이력 저장
          repo.addHistory({
            applicationId: nextApplicant.id,
            actorId: actor.id,
            action: 'AUTO_APPROVE',
            fromStatus: 'PENDING',
            toStatus: 'APPROVED',
            causeHistoryId: revokeHistoryId
          });
        }
        // 6. 결과 반환
        return {
          revoked,
          promoted
        };
      });
    }
  };
}
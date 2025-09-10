/**
 * 서버 측 중복 요청 방지를 위한 요청 관리자
 */
export class RequestManager {
  private processingRequests = new Map<string, Set<string>>();
  private timeouts = new Map<string, NodeJS.Timeout>();

  /**
   * 요청 처리 시작
   * @param socketId 소켓 ID
   * @param requestType 요청 타입
   * @returns 처리 가능하면 true, 이미 처리 중이면 false
   */
  startProcessing(socketId: string, requestType: string): boolean {
    if (this.isProcessing(socketId, requestType)) {
      return false;
    }

    if (!this.processingRequests.has(socketId)) {
      this.processingRequests.set(socketId, new Set());
    }

    this.processingRequests.get(socketId)!.add(requestType);

    // 30초 후 자동으로 요청 상태 해제 (타임아웃 보호)
    const timeoutKey = `${socketId}:${requestType}`;
    const timeout = setTimeout(() => {
      console.warn(`Request timeout for ${socketId}:${requestType}`);
      this.finishProcessing(socketId, requestType);
    }, 30000);

    this.timeouts.set(timeoutKey, timeout);

    return true;
  }

  /**
   * 요청 처리 완료
   * @param socketId 소켓 ID
   * @param requestType 요청 타입
   */
  finishProcessing(socketId: string, requestType: string): void {
    const requests = this.processingRequests.get(socketId);
    if (requests) {
      requests.delete(requestType);
      if (requests.size === 0) {
        this.processingRequests.delete(socketId);
      }
    }

    // 타임아웃 정리
    const timeoutKey = `${socketId}:${requestType}`;
    const timeout = this.timeouts.get(timeoutKey);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(timeoutKey);
    }
  }

  /**
   * 요청 처리 중인지 확인
   * @param socketId 소켓 ID
   * @param requestType 요청 타입
   * @returns 처리 중이면 true
   */
  isProcessing(socketId: string, requestType: string): boolean {
    const requests = this.processingRequests.get(socketId);
    return requests ? requests.has(requestType) : false;
  }

  /**
   * 특정 소켓의 모든 요청 상태 정리
   * @param socketId 소켓 ID
   */
  cleanup(socketId: string): void {
    const requests = this.processingRequests.get(socketId);
    if (requests) {
      // 해당 소켓의 모든 타임아웃 정리
      requests.forEach((requestType) => {
        const timeoutKey = `${socketId}:${requestType}`;
        const timeout = this.timeouts.get(timeoutKey);
        if (timeout) {
          clearTimeout(timeout);
          this.timeouts.delete(timeoutKey);
        }
      });

      this.processingRequests.delete(socketId);
    }
  }

  /**
   * 현재 처리 중인 요청 상태 로깅 (디버깅용)
   */
  logStatus(): void {
    console.log(
      'Processing requests:',
      Object.fromEntries(this.processingRequests)
    );
  }
}

// 싱글톤 인스턴스
export const requestManager = new RequestManager();

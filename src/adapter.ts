// 코딩 에이전트 실행 어댑터 계약.
// 관리자는 launch 전에 request_id·작업 디렉터리·시작 의도를 먼저 저장하고,
// 재시작 뒤에는 lookup 으로 그 request_id 의 실제 실행을 다시 찾는다.

export type LaunchRequest = {
  requestId: string;
  workdir: string;
  prompt: string;
};

// succeeded/failed: 에이전트 실행이 끝났다는 뜻일 뿐이다. 작업 done 은 통합·인수 검증을 거쳐야 한다
// not_found: 이 request_id 로 시작된 실행이 없다고 어댑터가 영속 기록으로 확인했다.
//            기록을 잃었거나 읽을 수 없으면 not_found 가 아니라 unknown 을 돌려준다
// unknown:   살아 있는지, 시작됐는지 확인할 수 없다
export type LookupResult = 'running' | 'succeeded' | 'failed' | 'not_found' | 'unknown';

export interface Adapter {
  launch(req: LaunchRequest): Promise<void>;
  lookup(requestId: string): Promise<LookupResult>;
}

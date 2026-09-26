import { readFileSync, writeFileSync } from 'node:fs';
import type { Adapter, LaunchRequest, LookupResult } from './adapter.ts';

type Store = {
  runs: Record<string, 'running' | 'succeeded' | 'failed'>;
  launchCount: Record<string, number>;
};

// 장애 주입용 가짜 어댑터. 관리자 밖의 "실제 세계"를 흉내 내므로 상태를 파일에 둔다.
// 관리자 프로세스가 죽어도 이 파일은 남아서, 새 프로세스의 새 인스턴스도 이전 실행을 찾는다.
// launch 를 중복 제거하지 않는다 — 실제 CLI 도 같은 요청을 두 번 받으면 두 번 실행하기 때문이다.
export class FakeAdapter implements Adapter {
  readonly storePath: string;
  canLookup = true;
  readonly unreachable = new Set<string>();
  // true 면 실행 기록을 남긴 뒤 응답 전에 throw 한다
  throwAfterRecord = false;

  // 생성자는 기존 저장소를 열기만 한다. 여기서 빈 저장소를 만들면, 기록을 잃은 뒤 새로 띄운
  // 인스턴스가 이전 실행을 not_found 로 잘못 판정해 중복 시작하게 된다.
  constructor(storePath: string) {
    this.storePath = storePath;
  }

  // 프로젝트를 준비할 때 한 번만 부른다. 저장소가 있어야 not_found 를 믿을 수 있다
  static init(storePath: string): FakeAdapter {
    const a = new FakeAdapter(storePath);
    a.save({ runs: {}, launchCount: {} });
    return a;
  }

  private load(): Store | undefined {
    try {
      return JSON.parse(readFileSync(this.storePath, 'utf8')) as Store;
    } catch {
      return undefined;
    }
  }

  private save(s: Store): void {
    writeFileSync(this.storePath, JSON.stringify(s));
  }

  async launch(req: LaunchRequest): Promise<void> {
    const s = this.load();
    if (!s) throw new Error(`어댑터 저장소를 읽을 수 없다: ${this.storePath}`);
    s.launchCount[req.requestId] = (s.launchCount[req.requestId] ?? 0) + 1;
    s.runs[req.requestId] = 'running';
    this.save(s);
    if (this.throwAfterRecord) throw new Error('실행은 기록됐지만 응답 전에 연결이 끊겼다');
  }

  async lookup(requestId: string): Promise<LookupResult> {
    if (!this.canLookup || this.unreachable.has(requestId)) return 'unknown';
    const s = this.load();
    // 기록 저장소를 읽을 수 없으면 "시작된 적 없음"이라고 말할 근거가 없다
    if (!s) return 'unknown';
    return s.runs[requestId] ?? 'not_found';
  }

  finish(requestId: string, result: 'succeeded' | 'failed'): void {
    const s = this.load()!;
    s.runs[requestId] = result;
    this.save(s);
  }

  launchCount(requestId: string): number {
    return this.load()?.launchCount[requestId] ?? 0;
  }

  totalLaunches(): number {
    return Object.values(this.load()?.launchCount ?? {}).reduce((a, b) => a + b, 0);
  }
}

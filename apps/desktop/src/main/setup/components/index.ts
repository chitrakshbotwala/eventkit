import type { ComponentId } from '@eventkit/shared';
import type { AnyRunner } from '../types';
import { androidRunner } from './android';
import { chromeRunner } from './chrome';
import { devtoolsRunner } from './devtools';
import { flutterRunner } from './flutter';
import { gitRunner } from './git';
import { javaRunner } from './java';
import { linuxDepsRunner } from './linux-deps';
import { systemRunner, type SystemDeps } from './system';
import { verifyRunner } from './verify';
import { vscodeRunner } from './vscode';
import { warmupRunner } from './warmup';

/** Runners are typed per component; the engine dispatches by id. */
const any = (r: unknown) => r as AnyRunner;

/** Real installers per component (platform differences handled inside each runner). */
export function realRunners(deps: SystemDeps): Partial<Record<ComponentId, AnyRunner>> {
  return {
    system: any(systemRunner(deps)),
    'linux-deps': any(linuxDepsRunner),
    git: any(gitRunner),
    flutter: any(flutterRunner),
    java: any(javaRunner),
    android: any(androidRunner),
    chrome: any(chromeRunner),
    vscode: any(vscodeRunner),
    devtools: any(devtoolsRunner),
    warmup: any(warmupRunner),
    verify: any(verifyRunner),
  };
}

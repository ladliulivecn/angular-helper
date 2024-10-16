import * as path from 'path';
import Mocha from 'mocha';
import {glob} from 'glob';

export function run(): Promise<void> {
    // Create the mocha test
    const mocha = new Mocha({
        ui: 'tdd',
        color: true
    });

    const testsRoot = path.resolve(__dirname, '..');

    return new Promise((c, e) => {
        glob('**/**.test.js', { cwd: testsRoot }).then((files) => {
            // 添加文件到测试套件
            files.forEach((f: string) => mocha.addFile(path.resolve(testsRoot, f)));

            try {
                // 运行 mocha 测试
                mocha.run((failures: number) => {
                    if (failures > 0) {
                        e(new Error(`${failures} 个测试失败。`));
                    } else {
                        c();
                    }
                });
            } catch (err) {
                e(err);
            }
        }).catch((err) => {
            e(err);
        });
    });
}
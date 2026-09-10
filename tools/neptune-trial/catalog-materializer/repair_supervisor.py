"""Fixed repair-plan subprocess under the existing independent deadline supervisor."""
import json
from pathlib import Path
import subprocess
import sys
from supervisor import supervise


def start(_command, **kwargs):
    return subprocess.Popen([sys.executable, str(Path(__file__).with_name('repair_runtime.py'))], **kwargs)


if __name__ == '__main__':
    result = supervise(factory=start)
    print(json.dumps(result, separators=(',', ':')), flush=True)
    sys.exit(0 if result.get('status') == 'inspected' else 1)

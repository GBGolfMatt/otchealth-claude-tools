import hashlib, json, subprocess, sys, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).parent; VERIFY=ROOT/'verify.py'; COMMIT='a'*40
class VerifyTest(unittest.TestCase):
 def run_case(self, extra=False, link=False):
  with tempfile.TemporaryDirectory() as td:
   d=Path(td); vendor=d/'vendor'; vendor.mkdir(); data=b'worker\n'; (vendor/'main.py').write_bytes(data)
   if extra: (vendor/'extra.py').write_text('x')
   if link: (vendor/'link').symlink_to(vendor/'main.py')
   manifest=d/'origin.json'; manifest.write_text(json.dumps({'origin_repository':'InnerScopeHearing/otchealth-cto','source_commit':COMMIT,'component_path':'tools/neptune-trial/catalog-materializer','files':[{'path':'main.py','sha256':hashlib.sha256(data).hexdigest(),'size':len(data)}]}))
   return subprocess.run([sys.executable,str(VERIFY),'--expected-source-commit',COMMIT,'--manifest',str(manifest),'--component-dir',str(vendor),'--receipt',str(d/'receipt.json')],cwd=ROOT.parent.parent,capture_output=True,text=True)
 def test_exact_bundle(self): self.assertEqual(self.run_case().returncode,0)
 def test_extra_file_rejected(self): self.assertNotEqual(self.run_case(extra=True).returncode,0)
 def test_link_rejected(self): self.assertNotEqual(self.run_case(link=True).returncode,0)
if __name__=='__main__': unittest.main()

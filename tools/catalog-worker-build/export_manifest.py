#!/usr/bin/env python3
"""Export hashes for only the catalog materializer from a local git object database."""
import argparse, hashlib, json, subprocess
from pathlib import PurePosixPath, Path
from verify import ORIGIN, COMPONENT, safe_path
def git(repo, *args): return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True).stdout
def main():
 p=argparse.ArgumentParser(); p.add_argument("--source-repo",required=True); p.add_argument("--source-commit",required=True); p.add_argument("--output",required=True); a=p.parse_args()
 if len(a.source_commit)!=40 or any(c not in "0123456789abcdef" for c in a.source_commit): raise SystemExit("source commit must be 40 lowercase hex")
 rows=git(a.source_repo,"ls-tree","-r","-z",a.source_commit,"--",COMPONENT).split(b"\0"); files=[]
 for row in filter(None,rows):
  meta,path=row.split(b"\t",1); mode,kind,blob=meta.decode().split(); rel=PurePosixPath(path.decode()).relative_to(COMPONENT); safe_path(str(rel))
  if mode=="120000" or kind!="blob": raise SystemExit("source component contains symlink or non-blob")
  data=git(a.source_repo,"cat-file","blob",blob); files.append({"path":str(rel),"sha256":hashlib.sha256(data).hexdigest(),"size":len(data)})
 if not files: raise SystemExit("component missing at source commit")
 Path(a.output).write_text(json.dumps({"origin_repository":ORIGIN,"source_commit":a.source_commit,"component_path":COMPONENT,"files":sorted(files,key=lambda x:x["path"])},indent=2)+"\n")
if __name__=="__main__": main()

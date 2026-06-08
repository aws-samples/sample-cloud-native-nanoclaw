"""Step 0 preflight: python deps, AWS credentials, S3 bucket reachability/write."""
import importlib
import subprocess
import sys
import boto3
from botocore.exceptions import ClientError, NoCredentialsError


def check_python_deps(modules):
    """Return the list of module names that are not importable."""
    missing = []
    for name in modules:
        try:
            importlib.import_module(name)
        except ImportError:
            missing.append(name)
    return missing


def ensure_python_deps(modules) -> bool:
    """pip install any missing modules. Returns True if all present afterward."""
    missing = check_python_deps(modules)
    if not missing:
        return True
    subprocess.run([sys.executable, "-m", "pip", "install", *missing], check=False)
    return check_python_deps(modules) == []


def check_aws_credentials() -> bool:
    try:
        boto3.client("sts").get_caller_identity()
        return True
    except (ClientError, NoCredentialsError):
        return False


def classify_head_error(status_code: int) -> str:
    return {404: "missing", 403: "forbidden", 301: "region_mismatch"}.get(status_code, "error")


def check_s3_bucket(bucket: str, region: str) -> str:
    """Return 'ok' | 'missing' | 'forbidden' | 'region_mismatch' | 'error'."""
    s3 = boto3.client("s3", region_name=region)
    try:
        s3.head_bucket(Bucket=bucket)
        return "ok"
    except ClientError as e:
        code = int(e.response["ResponseMetadata"].get("HTTPStatusCode", 0))
        return classify_head_error(code)


def s3_write_probe(bucket: str, prefix: str, region: str) -> bool:
    """Put a tiny object then delete it to confirm write permission."""
    s3 = boto3.client("s3", region_name=region)
    key = f"{prefix.rstrip('/')}/.preflight"
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=b"ok")
        s3.delete_object(Bucket=bucket, Key=key)
        return True
    except ClientError:
        return False

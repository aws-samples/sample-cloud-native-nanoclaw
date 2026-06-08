"""Upload the report to S3 and return a presigned GET URL."""
import re
from pathlib import Path
import boto3
from botocore.config import Config

_SLUG = re.compile(r"[^\w一-鿿]+")

# S3 presigned URLs must use SigV4 so the URL carries X-Amz-Expires (the
# default per-region behavior can fall back to the legacy SigV2 scheme).
_SIGV4 = Config(signature_version="s3v4")


def build_key(prefix: str, subject: str, stamp: str) -> str:
    slug = _SLUG.sub("-", subject).strip("-") or "report"
    return f"{prefix.rstrip('/')}/{slug}-{stamp}.html"


def upload_bytes(client, bucket: str, key: str, body: bytes) -> None:
    client.put_object(Bucket=bucket, Key=key, Body=body,
                      ContentType="text/html; charset=utf-8")


def presign(client, bucket: str, key: str, expiry: int) -> str:
    return client.generate_presigned_url(
        "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=expiry)


def publish(report_path: str, config: dict, subject: str, stamp: str) -> str:
    """Upload report file and return a presigned URL (orchestration entrypoint)."""
    client = boto3.client("s3", region_name=config["region"], config=_SIGV4)
    key = build_key(config["prefix"], subject, stamp)
    upload_bytes(client, config["bucket"], key, Path(report_path).read_bytes())
    return presign(client, config["bucket"], key, config["presign_expiry_seconds"])

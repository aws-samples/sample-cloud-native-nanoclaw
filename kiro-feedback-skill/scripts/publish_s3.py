"""Upload the report to S3 and return a presigned GET URL."""
import re
from pathlib import Path
import boto3
from botocore.config import Config

_SLUG = re.compile(r"[^\w一-鿿]+")


def build_key(prefix: str, subject: str, stamp: str) -> str:
    slug = _SLUG.sub("-", subject).strip("-") or "report"
    return f"{prefix.rstrip('/')}/{slug}-{stamp}.html"


def upload_bytes(client, bucket: str, key: str, body: bytes) -> None:
    client.put_object(Bucket=bucket, Key=key, Body=body,
                      ContentType="text/html; charset=utf-8")


def presign(client, bucket: str, key: str, expiry: int) -> str:
    # Ensure SigV4 presigned URLs by reconstructing the client with explicit config.
    region = client.meta.region_name
    session = client._endpoint._event_emitter  # unused — use boto3.session instead
    sigv4_client = boto3.client(
        "s3",
        region_name=region,
        aws_access_key_id=client._request_signer._credentials.access_key,
        aws_secret_access_key=client._request_signer._credentials.secret_key,
        config=Config(signature_version="s3v4"),
    )
    return sigv4_client.generate_presigned_url(
        "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=expiry)


def publish(report_path: str, config: dict, subject: str, stamp: str) -> str:
    """Upload report file and return a presigned URL (orchestration entrypoint)."""
    client = boto3.client("s3", region_name=config["region"],
                          config=Config(signature_version="s3v4"))
    key = build_key(config["prefix"], subject, stamp)
    upload_bytes(client, config["bucket"], key, Path(report_path).read_bytes())
    return presign(client, config["bucket"], key, config["presign_expiry_seconds"])

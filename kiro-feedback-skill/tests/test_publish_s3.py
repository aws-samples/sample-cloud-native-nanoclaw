import boto3
from botocore.stub import Stubber
from scripts import publish_s3

def test_build_key_slugifies_and_dates():
    key = publish_s3.build_key("reports", "舆情 报告/v1", "20260608-120000")
    assert key.startswith("reports/")
    assert key.endswith("-20260608-120000.html")
    assert " " not in key and "/" not in key.split("reports/")[1]

def test_upload_sets_html_content_type():
    client = boto3.client("s3", region_name="us-west-2")
    stub = Stubber(client)
    stub.add_response("put_object", {}, {
        "Bucket": "b", "Key": "k.html", "Body": b"<html></html>",
        "ContentType": "text/html; charset=utf-8",
    })
    with stub:
        publish_s3.upload_bytes(client, "b", "k.html", b"<html></html>")
    stub.assert_no_pending_responses()

def test_presign_returns_url():
    client = boto3.client("s3", region_name="us-west-2",
                          aws_access_key_id="x", aws_secret_access_key="y")
    url = publish_s3.presign(client, "b", "k.html", 3600)
    assert url.startswith("https://")
    assert "X-Amz-Expires=3600" in url

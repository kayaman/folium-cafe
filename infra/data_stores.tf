resource "aws_dynamodb_table" "books" {
  name         = "${var.name_prefix}-books"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "id"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "id"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# Shared, on-demand cache of normalized Open Library entities. Private library
# items only retain references to records they use; TTL keeps the external cache
# fresh without mirroring Open Library wholesale.
resource "aws_dynamodb_table" "catalog" {
  name         = "${var.name_prefix}-catalog"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "id"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "id"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

resource "aws_s3_bucket" "pdfs" {
  bucket = "${var.name_prefix}-pdfs-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "pdfs" {
  bucket                  = aws_s3_bucket.pdfs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# The browser uploads/downloads directly to S3 via presigned URLs, which is a
# cross-origin request from the site, so the bucket needs CORS.
resource "aws_s3_bucket_cors_configuration" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id
  cors_rule {
    allowed_methods = ["GET", "PUT"]
    allowed_origins = ["https://${var.domain_name}"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

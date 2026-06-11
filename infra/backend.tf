terraform {
  backend "s3" {
    bucket         = "folio-tfstate-257394450889"
    key            = "read-magj-dev/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "folio-tflock"
    encrypt        = true
  }
}

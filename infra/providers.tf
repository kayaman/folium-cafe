# CloudFront requires its ACM cert in us-east-1, and the whole stack lives there,
# so a single default provider in us-east-1 suffices.
provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = {
      Project = "folium"
      App     = "folium.cafe"
    }
  }
}

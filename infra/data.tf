data "aws_caller_identity" "current" {}

data "aws_route53_zone" "primary" {
  name         = var.hosted_zone_name
  private_zone = false
}

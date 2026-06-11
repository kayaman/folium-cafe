output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "lambda_function_name" {
  value = aws_lambda_function.api.function_name
}

output "url" {
  value = "https://${var.domain_name}"
}

output "ci_role_arn" {
  value = aws_iam_role.ci.arn
}

output "folium_name_servers" {
  value = aws_route53_zone.folium.name_servers
}

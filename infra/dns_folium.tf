# Hosted zone for folium.cafe (registered at GoDaddy; delegated here via NS).
# The site/cert still point at var.domain_name — cut over only after the
# GoDaddy nameserver change propagates, or ACM validation will stall.
resource "aws_route53_zone" "folium" {
  name    = "folium.cafe"
  comment = "Folium — a private reading room"
}

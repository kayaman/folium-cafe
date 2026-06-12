# Hosted zone for folium.cafe (registered at GoDaddy; delegated here via NS).
resource "aws_route53_zone" "folium" {
  name    = "folium.cafe"
  comment = "Folium — a private reading room"
}

variable "domain_name" {
  type    = string
  default = "folium.cafe"
}

variable "hosted_zone_name" {
  type    = string
  default = "folium.cafe"
}

variable "github_repo" {
  type    = string
  default = "kayaman/folium-cafe"
}

variable "name_prefix" {
  type    = string
  default = "folium-cafe"
}

variable "bedrock_model_id" {
  description = "Bedrock cross-region inference-profile id for book-metadata extraction (us-east-1). Defaults to Claude Haiku 4.5 — the cheapest vision-capable model, ample for bibliographic extraction. The account owner must enable model access for it in the Bedrock console once. Override only to trade cost for accuracy (e.g. us.anthropic.claude-sonnet-4-6). List ids: aws bedrock list-inference-profiles --region us-east-1."
  type        = string
  default     = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
}

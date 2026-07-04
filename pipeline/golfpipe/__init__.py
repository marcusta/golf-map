"""golfpipe: tile pipeline for the golf-map project.

Turns Lantmateriet elevation (DEM) and orthophoto GeoTIFFs into XYZ tile
pyramids (JPEG ortho tiles, Terrain-RGB PNG terrain tiles) that the golf-map
server serves from data/tiles/{courseId}/{layer}/{z}/{x}/{y}.<ext>.

No system GDAL is required: everything goes through rasterio, whose wheels
bundle their own GDAL build.
"""

__version__ = "0.1.0"
